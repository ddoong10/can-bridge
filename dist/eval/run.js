import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { CodexAdapter } from "../adapters/codex.js";
import { loadEvalCase } from "./load-case.js";
import { scoreEvalRun } from "./score.js";
export async function runEvalCase(opts) {
    const testCase = await loadEvalCase(opts.casePath);
    const cwd = path.resolve(opts.cwd ?? process.cwd());
    const runDir = path.resolve(opts.outDir ??
        path.join(cwd, "runs", "evals", today(), testCase.taskId, `${opts.condition}-${stamp()}`));
    await fs.mkdir(runDir, { recursive: true });
    const commandsPath = path.join(runDir, "commands.jsonl");
    const transcriptPath = path.join(runDir, "transcript.txt");
    const statusPath = path.join(runDir, "status.json");
    const stats = {
        condition: opts.condition,
        agent: opts.agent,
        promptBytes: Buffer.byteLength(testCase.prompt, "utf8"),
    };
    await writeStatus(statusPath, {
        phase: "loaded-case",
        runDir,
        caseId: testCase.taskId,
        condition: opts.condition,
        agent: opts.agent,
        startedAt: new Date().toISOString(),
    });
    await appendFile(transcriptPath, `[can-bridge eval] loaded case ${testCase.taskId}\n`);
    console.error(`Eval run: ${runDir}`);
    console.error(`[1/5] Loaded case ${testCase.taskId}`);
    let resumeSessionId;
    if (opts.condition === "converted" && opts.source && opts.sourceSession) {
        console.error(`[2/5] Converting ${opts.source}:${opts.sourceSession} -> ${opts.agent}`);
        await writeStatus(statusPath, {
            phase: "converting-context",
            runDir,
            caseId: testCase.taskId,
            condition: opts.condition,
            agent: opts.agent,
            source: opts.source,
            sourceSession: opts.sourceSession,
            updatedAt: new Date().toISOString(),
        });
        const source = pickSource(opts.source);
        const target = pickTarget(opts.agent);
        const locator = opts.sourceSession === "latest"
            ? await latestSessionId(source)
            : opts.sourceSession;
        const ctx = await source.extract(locator);
        const result = await target.inject(ctx);
        resumeSessionId =
            typeof result.details?.sessionId === "string"
                ? result.details.sessionId
                : undefined;
        stats.source = {
            adapter: source.id,
            session: locator,
            messageCount: ctx.messages.length,
            contextBytes: Buffer.byteLength(JSON.stringify(ctx), "utf8"),
        };
        stats.injected = {
            target: target.id,
            sessionId: resumeSessionId,
            locator: result.locator,
        };
        await appendFile(transcriptPath, `[can-bridge eval] converted ${source.id}:${locator} -> ${target.id}:${resumeSessionId ?? result.locator}\n\n`);
    }
    else {
        console.error("[2/5] No context conversion for this condition");
    }
    const commandSpec = opts.command
        ? { cmd: commandFromTemplate(opts.command, testCase.prompt, resumeSessionId) }
        : defaultAgentCommand(opts.agent, testCase.prompt, resumeSessionId);
    console.error(`[3/5] Starting agent command: ${formatCommandForLog(commandSpec.cmd)}`);
    const run = await runCommand(commandSpec.cmd, cwd, runDir, {
        label: "agent",
        commandsPath,
        statusPath,
        stdinText: commandSpec.stdinText,
        statusBase: {
            runDir,
            caseId: testCase.taskId,
            condition: opts.condition,
            agent: opts.agent,
        },
    });
    await appendJsonl(commandsPath, run.record);
    await appendFile(transcriptPath, `# Command\n${commandSpec.cmd.join(" ")}\n\n`);
    if (commandSpec.stdinText !== undefined) {
        await appendFile(transcriptPath, `# stdin\n${commandSpec.stdinText}\n\n`);
    }
    await appendFile(transcriptPath, `# stdout\n${run.stdout}\n\n# stderr\n${run.stderr}\n`);
    console.error(`[3/5] Agent exited ${String(run.record.exitCode)}`);
    console.error("[4/5] Capturing git diff");
    const diff = await runCommand(["git", "diff", "--binary"], cwd, runDir, {
        label: "git-diff",
        commandsPath,
        statusPath,
        statusBase: {
            runDir,
            caseId: testCase.taskId,
            condition: opts.condition,
            agent: opts.agent,
        },
    });
    await appendJsonl(commandsPath, diff.record);
    const untracked = await runCommand(["git", "ls-files", "--others", "--exclude-standard"], cwd, runDir, {
        label: "git-untracked",
        commandsPath,
        statusPath,
        statusBase: {
            runDir,
            caseId: testCase.taskId,
            condition: opts.condition,
            agent: opts.agent,
        },
    });
    await appendJsonl(commandsPath, untracked.record);
    const untrackedDiff = await renderUntrackedDiff(cwd, untracked.stdout);
    await fs.writeFile(path.join(runDir, "diff.patch"), diff.stdout + untrackedDiff, "utf8");
    await fs.writeFile(path.join(runDir, "context-stats.json"), JSON.stringify(stats, null, 2) + "\n", "utf8");
    if (opts.noScore)
        return { runDir };
    console.error("[5/5] Scoring run");
    await writeStatus(statusPath, {
        phase: "scoring",
        runDir,
        caseId: testCase.taskId,
        condition: opts.condition,
        agent: opts.agent,
        updatedAt: new Date().toISOString(),
    });
    const score = await scoreEvalRun(opts.casePath, runDir);
    const scorePath = path.join(runDir, "score.json");
    await fs.writeFile(scorePath, JSON.stringify(score, null, 2) + "\n", "utf8");
    await writeStatus(statusPath, {
        phase: "complete",
        runDir,
        caseId: testCase.taskId,
        condition: opts.condition,
        agent: opts.agent,
        scorePath,
        valid: score.valid,
        finalScore: score.scores.final,
        finishedAt: new Date().toISOString(),
    });
    console.error(`[5/5] Score ${score.scores.final.toFixed(1)} (${score.valid ? "valid" : "invalid"})`);
    return { runDir, scorePath };
}
function defaultAgentCommand(agent, prompt, resumeSessionId) {
    if (agent === "codex") {
        const executable = process.platform === "win32" ? "codex.cmd" : "codex";
        const cmd = resumeSessionId
            ? [
                executable,
                "exec",
                "--skip-git-repo-check",
                "--sandbox",
                "workspace-write",
                "resume",
                resumeSessionId,
            ]
            : [executable, "exec", "--skip-git-repo-check", "--sandbox", "workspace-write"];
        return { cmd, stdinText: prompt };
    }
    const executable = process.platform === "win32" ? "claude.cmd" : "claude";
    return {
        cmd: resumeSessionId
            ? [executable, "--print", "--resume", resumeSessionId, prompt]
            : [executable, "--print", prompt],
    };
}
export function commandFromTemplate(template, prompt, resumeSessionId) {
    const promptToken = "\u0000CAN_BRIDGE_PROMPT\u0000";
    const sessionToken = "\u0000CAN_BRIDGE_SESSION\u0000";
    const rendered = template
        .replaceAll("{{prompt}}", promptToken)
        .replaceAll("{{sessionId}}", sessionToken);
    return splitCommand(rendered).map((part) => part
        .replaceAll(promptToken, prompt)
        .replaceAll(sessionToken, resumeSessionId ?? ""));
}
function splitCommand(command) {
    const out = [];
    let cur = "";
    let quote = null;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote) {
            if (ch === quote)
                quote = null;
            else
                cur += ch;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if (/\s/.test(ch)) {
            if (cur) {
                out.push(cur);
                cur = "";
            }
            continue;
        }
        cur += ch;
    }
    if (cur)
        out.push(cur);
    return out;
}
async function runCommand(cmd, cwd, runDir, opts) {
    const startedAt = new Date().toISOString();
    const safeStart = startedAt.replace(/[:.]/g, "-");
    const stdoutFile = path.join(runDir, `${safeStart}.${opts.label}.stdout.txt`);
    const stderrFile = path.join(runDir, `${safeStart}.${opts.label}.stderr.txt`);
    const stdoutHandle = await fs.open(stdoutFile, "w");
    const stderrHandle = await fs.open(stderrFile, "w");
    const startedRecord = {
        cmd,
        cwd,
        startedAt,
        finishedAt: "",
        exitCode: null,
        stdoutFile: path.basename(stdoutFile),
        stderrFile: path.basename(stderrFile),
    };
    await appendJsonl(opts.commandsPath, { ...startedRecord, status: "started" });
    await writeStatus(opts.statusPath, {
        ...opts.statusBase,
        phase: `${opts.label}-running`,
        currentCommand: cmd,
        stdoutFile: path.basename(stdoutFile),
        stderrFile: path.basename(stderrFile),
        stdin: opts.stdinText !== undefined,
        updatedAt: startedAt,
    });
    const result = await new Promise((resolve) => {
        const spawnCmd = prepareSpawnCommand(cmd);
        const child = spawn(spawnCmd.file, spawnCmd.args, {
            cwd,
            windowsHide: true,
            stdio: [opts.stdinText !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        });
        if (opts.stdinText !== undefined) {
            child.stdin?.end(opts.stdinText + "\n");
        }
        const stdoutChunks = [];
        const stderrChunks = [];
        child.stdout?.on("data", (chunk) => {
            stdoutChunks.push(chunk);
            void stdoutHandle.write(chunk);
        });
        child.stderr?.on("data", (chunk) => {
            stderrChunks.push(chunk);
            void stderrHandle.write(chunk);
        });
        child.on("close", (code) => {
            resolve({
                exitCode: code,
                stdout: Buffer.concat(stdoutChunks).toString("utf8"),
                stderr: Buffer.concat(stderrChunks).toString("utf8"),
            });
        });
        child.on("error", (err) => {
            resolve({
                exitCode: null,
                stdout: "",
                stderr: err instanceof Error ? err.message : String(err),
            });
        });
    });
    await stdoutHandle.close();
    await stderrHandle.close();
    return {
        stdout: result.stdout,
        stderr: result.stderr,
        record: {
            cmd,
            cwd,
            startedAt,
            finishedAt: new Date().toISOString(),
            exitCode: result.exitCode,
            stdoutFile: path.basename(stdoutFile),
            stderrFile: path.basename(stderrFile),
        },
    };
}
function formatCommandForLog(cmd) {
    return cmd
        .map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))
        .join(" ");
}
function prepareSpawnCommand(cmd) {
    const file = cmd[0];
    const args = cmd.slice(1);
    if (process.platform === "win32" &&
        (file.toLowerCase().endsWith(".cmd") || file.toLowerCase().endsWith(".bat"))) {
        const comspec = process.env.ComSpec || "cmd.exe";
        return {
            file: comspec,
            args: ["/d", "/s", "/c", cmd.map(quoteWindowsCmdArg).join(" ")],
        };
    }
    return { file, args };
}
function quoteWindowsCmdArg(arg) {
    if (arg.length === 0)
        return '""';
    if (!/[()\s"%!^&|<>]/.test(arg))
        return arg;
    return `"${arg.replace(/(["^&|<>])/g, "^$1").replace(/%/g, "%%")}"`;
}
function pickSource(id) {
    return id === "codex" ? new CodexAdapter() : new ClaudeCodeAdapter();
}
function pickTarget(id) {
    return id === "codex" ? new CodexAdapter() : new ClaudeCodeAdapter();
}
async function latestSessionId(source) {
    if (!source.listSessions) {
        throw new Error(`Source ${source.id} does not support latest session lookup`);
    }
    const sessions = await source.listSessions();
    if (sessions.length === 0)
        throw new Error(`No sessions found for ${source.id}`);
    return sessions.reduce((best, session) => {
        const bt = Date.parse(best.updatedAt ?? "");
        const st = Date.parse(session.updatedAt ?? "");
        if (Number.isNaN(bt))
            return session;
        if (Number.isNaN(st))
            return best;
        return st > bt ? session : best;
    }).id;
}
async function renderUntrackedDiff(cwd, stdout) {
    const files = stdout
        .split(/\r?\n/)
        .map((line) => normalizePath(line.trim()))
        .filter((line) => line.length > 0);
    let out = "";
    for (const file of files) {
        let content;
        try {
            content = await fs.readFile(path.join(cwd, file), "utf8");
        }
        catch {
            continue;
        }
        out += `diff --git a/${file} b/${file}\n`;
        out += "new file mode 100644\n";
        out += "--- /dev/null\n";
        out += `+++ b/${file}\n`;
        for (const line of content.split(/\r?\n/)) {
            out += `+${line}\n`;
        }
    }
    return out;
}
function normalizePath(value) {
    return value.replace(/\\/g, "/").replace(/^\.?\//, "");
}
async function appendJsonl(filePath, value) {
    await appendFile(filePath, JSON.stringify(value) + "\n");
}
async function appendFile(filePath, value) {
    await fs.appendFile(filePath, value, "utf8");
}
async function writeStatus(filePath, value) {
    await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}
function today() {
    return new Date().toISOString().slice(0, 10);
}
function stamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}
//# sourceMappingURL=run.js.map