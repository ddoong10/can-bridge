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
  const stats: EvalContextStats = {
    condition: opts.condition,
    agent: opts.agent,
    promptBytes: Buffer.byteLength(testCase.prompt, "utf8"),
  };

  let resumeSessionId: string | undefined;
  if (opts.condition === "converted" && opts.source && opts.sourceSession) {
    const source = pickSource(opts.source);
    const target = pickTarget(opts.agent);
    const locator =
      opts.sourceSession === "latest"
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
    await appendFile(
      transcriptPath,
      `[can-bridge eval] converted ${source.id}:${locator} -> ${target.id}:${resumeSessionId ?? result.locator}\n\n`,
    );
  }

  const cmd = opts.command
    ? commandFromTemplate(opts.command, testCase.prompt, resumeSessionId)
    : defaultAgentCommand(opts.agent, testCase.prompt, resumeSessionId);

  const run = await runCommand(cmd, cwd, runDir);
  await appendJsonl(commandsPath, run.record);
  await appendFile(transcriptPath, `# Command\n${cmd.join(" ")}\n\n`);
  await appendFile(transcriptPath, `# stdout\n${run.stdout}\n\n# stderr\n${run.stderr}\n`);

  const diff = await runCommand(["git", "diff", "--binary"], cwd, runDir);
  await appendJsonl(commandsPath, diff.record);
  await fs.writeFile(path.join(runDir, "diff.patch"), diff.stdout, "utf8");
  await fs.writeFile(
    path.join(runDir, "context-stats.json"),
    JSON.stringify(stats, null, 2) + "\n",
    "utf8",
  );

  if (opts.noScore) return { runDir };
  const score = await scoreEvalRun(opts.casePath, runDir);
  const scorePath = path.join(runDir, "score.json");
  await fs.writeFile(scorePath, JSON.stringify(score, null, 2) + "\n", "utf8");
  return { runDir, scorePath };
}

function defaultAgentCommand(
  agent: EvalAgent,
  prompt: string,
  resumeSessionId: string | undefined,
): string[] {
  if (agent === "codex") {
    return resumeSessionId
      ? ["codex", "exec", "--skip-git-repo-check", "resume", resumeSessionId, prompt]
      : ["codex", "exec", "--skip-git-repo-check", prompt];
  }
  return resumeSessionId
    ? ["claude", "--print", "--resume", resumeSessionId, prompt]
    : ["claude", "--print", prompt];
}

function commandFromTemplate(
  template: string,
  prompt: string,
  resumeSessionId: string | undefined,
): string[] {
  const rendered = template
    .replaceAll("{{prompt}}", prompt)
    .replaceAll("{{sessionId}}", resumeSessionId ?? "");
  return splitCommand(rendered);
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
): Promise<{ record: EvalCommandRecord; stdout: string; stderr: string }> {
  const startedAt = new Date().toISOString();
  const stdoutFile = path.join(runDir, `${startedAt.replace(/[:.]/g, "-")}.stdout.txt`);
  const stderrFile = path.join(runDir, `${startedAt.replace(/[:.]/g, "-")}.stderr.txt`);
  const result = await new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      cwd,
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
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
  await fs.writeFile(stdoutFile, result.stdout, "utf8");
  await fs.writeFile(stderrFile, result.stderr, "utf8");
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

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await appendFile(filePath, JSON.stringify(value) + "\n");
}

async function appendFile(filePath: string, value: string): Promise<void> {
  await fs.appendFile(filePath, value, "utf8");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
