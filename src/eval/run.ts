import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { CodexAdapter } from "../adapters/codex.js";
import type { SourceAdapter, TargetAdapter } from "../adapters/base.js";
import { loadEvalCase } from "./load-case.js";
import { scoreEvalRun } from "./score.js";
import type {
  EvalAgent,
  EvalCommandRecord,
  EvalCondition,
  EvalContextStats,
} from "./types.js";

export interface EvalRunOptions {
  casePath: string;
  condition: EvalCondition;
  agent: EvalAgent;
  cwd?: string;
  outDir?: string;
  source?: "codex" | "claude-code";
  sourceSession?: string;
  command?: string;
  noScore?: boolean;
}

interface EvalCommandSpec {
  cmd: string[];
  stdinText?: string;
}

export async function runEvalCase(opts: EvalRunOptions): Promise<{
  runDir: string;
  scorePath?: string;
}> {
  const testCase = await loadEvalCase(opts.casePath);
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const runDir = path.resolve(
    opts.outDir ??
      path.join(
        cwd,
        "runs",
        "evals",
        today(),
        testCase.taskId,
        `${opts.condition}-${stamp()}`,
      ),
  );
  await fs.mkdir(runDir, { recursive: true });

  const commandsPath = path.join(runDir, "commands.jsonl");
  const transcriptPath = path.join(runDir, "transcript.txt");
  const statusPath = path.join(runDir, "status.json");
  const stats: EvalContextStats = {
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
  await appendFile(
    transcriptPath,
    `[can-bridge eval] loaded case ${testCase.taskId}\n`,
  );
  console.error(`Eval run: ${runDir}`);
  console.error(`[1/5] Loaded case ${testCase.taskId}`);

  let resumeSessionId: string | undefined;
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
    const locator =
      opts.sourceSession === "latest"
        ? await latestSessionId(source)
        : opts.sourceSession;
    const ctx = await source.extract(locator);
    ctx.source.cwd = cwd;
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
    await appendFile(
      transcriptPath,
      `[can-bridge eval] converted ${source.id}:${locator} -> ${target.id}:${resumeSessionId ?? result.locator}\n\n`,
    );
  } else {
    console.error("[2/5] No context conversion for this condition");
  }

  const commandSpec: EvalCommandSpec = opts.command
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
  const untracked = await runCommand(
    ["git", "ls-files", "--others", "--exclude-standard"],
    cwd,
    runDir,
    {
      label: "git-untracked",
      commandsPath,
      statusPath,
      statusBase: {
        runDir,
        caseId: testCase.taskId,
        condition: opts.condition,
        agent: opts.agent,
      },
    },
  );
  await appendJsonl(commandsPath, untracked.record);
  const untrackedDiff = await renderUntrackedDiff(cwd, untracked.stdout);
  await fs.writeFile(path.join(runDir, "diff.patch"), diff.stdout + untrackedDiff, "utf8");
  await fs.writeFile(
    path.join(runDir, "context-stats.json"),
    JSON.stringify(stats, null, 2) + "\n",
    "utf8",
  );

  if (opts.noScore) return { runDir };
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

function defaultAgentCommand(
  agent: EvalAgent,
  prompt: string,
  resumeSessionId: string | undefined,
): EvalCommandSpec {
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

export function commandFromTemplate(
  template: string,
  prompt: string,
  resumeSessionId: string | undefined,
): string[] {
  const promptToken = "\u0000CAN_BRIDGE_PROMPT\u0000";
  const sessionToken = "\u0000CAN_BRIDGE_SESSION\u0000";
  const rendered = template
    .replaceAll("{{prompt}}", promptToken)
    .replaceAll("{{sessionId}}", sessionToken);
  return splitCommand(rendered).map((part) =>
    part
      .replaceAll(promptToken, prompt)
      .replaceAll(sessionToken, resumeSessionId ?? ""),
  );
}

function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
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
  if (cur) out.push(cur);
  return out;
}

async function runCommand(
  cmd: string[],
  cwd: string,
  runDir: string,
  opts: {
    label: string;
    commandsPath: string;
    statusPath: string;
    stdinText?: string;
    statusBase: Record<string, unknown>;
  },
): Promise<{ record: EvalCommandRecord; stdout: string; stderr: string }> {
  const startedAt = new Date().toISOString();
  const safeStart = startedAt.replace(/[:.]/g, "-");
  const stdoutFile = path.join(runDir, `${safeStart}.${opts.label}.stdout.txt`);
  const stderrFile = path.join(runDir, `${safeStart}.${opts.label}.stderr.txt`);
  const stdoutHandle = await fs.open(stdoutFile, "w");
  const stderrHandle = await fs.open(stderrFile, "w");
  const startedRecord: EvalCommandRecord = {
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
  const result = await new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const spawnCmd = prepareSpawnCommand(cmd);
    const child = spawn(spawnCmd.file, spawnCmd.args, {
      cwd,
      windowsHide: true,
      stdio: [opts.stdinText !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (opts.stdinText !== undefined) {
      child.stdin?.end(opts.stdinText + "\n");
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      void stdoutHandle.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
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

function formatCommandForLog(cmd: string[]): string {
  return cmd
    .map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))
    .join(" ");
}

function prepareSpawnCommand(cmd: string[]): { file: string; args: string[] } {
  const file = cmd[0]!;
  const args = cmd.slice(1);
  if (
    process.platform === "win32" &&
    (file.toLowerCase().endsWith(".cmd") || file.toLowerCase().endsWith(".bat"))
  ) {
    const comspec = process.env.ComSpec || "cmd.exe";
    return {
      file: comspec,
      args: ["/d", "/s", "/c", cmd.map(quoteWindowsCmdArg).join(" ")],
    };
  }
  return { file, args };
}

function quoteWindowsCmdArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[()\s"%!^&|<>]/.test(arg)) return arg;
  return `"${arg.replace(/(["^&|<>])/g, "^$1").replace(/%/g, "%%")}"`;
}

function pickSource(id: "codex" | "claude-code"): SourceAdapter {
  return id === "codex" ? new CodexAdapter() : new ClaudeCodeAdapter();
}

function pickTarget(id: EvalAgent): TargetAdapter {
  return id === "codex" ? new CodexAdapter() : new ClaudeCodeAdapter();
}

async function latestSessionId(source: SourceAdapter): Promise<string> {
  if (!source.listSessions) {
    throw new Error(`Source ${source.id} does not support latest session lookup`);
  }
  const sessions = await source.listSessions();
  if (sessions.length === 0) throw new Error(`No sessions found for ${source.id}`);
  return sessions.reduce((best, session) => {
    const bt = Date.parse(best.updatedAt ?? "");
    const st = Date.parse(session.updatedAt ?? "");
    if (Number.isNaN(bt)) return session;
    if (Number.isNaN(st)) return best;
    return st > bt ? session : best;
  }).id;
}

async function renderUntrackedDiff(cwd: string, stdout: string): Promise<string> {
  const files = stdout
    .split(/\r?\n/)
    .map((line) => normalizePath(line.trim()))
    .filter((line) => line.length > 0);
  let out = "";
  for (const file of files) {
    let content: string;
    try {
      content = await fs.readFile(path.join(cwd, file), "utf8");
    } catch {
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

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "");
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await appendFile(filePath, JSON.stringify(value) + "\n");
}

async function appendFile(filePath: string, value: string): Promise<void> {
  await fs.appendFile(filePath, value, "utf8");
}

async function writeStatus(
  filePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
