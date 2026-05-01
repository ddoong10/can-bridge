#!/usr/bin/env node
/**
 * can-bridge — portable context handoff for Claude Code and Codex CLI
 *
 * Usage:
 *   can-bridge export --from claude-code --session <id|path> [--out file.json]
 *   can-bridge import --to codex --in file.json
 *   can-bridge pipe   --from claude-code --session <id> --to codex
 *   can-bridge pipe   --from claude-code --session <id> --to codex --as-prompt
 *   can-bridge continue --from claude-code --to codex --latest
 *   can-bridge doctor --from codex --session <id|path> [--json]
 *   can-bridge list   --from claude-code
 */

import { promises as fs } from "node:fs";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { CodexAdapter } from "../adapters/codex.js";
import type {
  InjectionResult,
  SessionSummary,
  SourceAdapter,
  TargetAdapter,
} from "../adapters/base.js";
import {
  formatMessages,
  listInbox,
  listThread,
  readMessages,
  sendMessage,
} from "../collab/mailbox.js";
import {
  diagnoseSession,
  formatDoctorResult,
} from "../doctor/session-doctor.js";
import type { NormalizedContext } from "../schema/context.js";
import { isCbctxPackage } from "../schema/cbctx.js";
import { redactContext } from "../transform/redactor.js";
import {
  buildPackage,
  defaultPackageName,
  writePackage,
} from "../share/share.js";
import {
  formatImportSummary,
  importPackage,
} from "../share/import.js";
import { UNTRUSTED_FENCE_HEADER } from "../transform/fence.js";

const SOURCES: Record<string, () => SourceAdapter> = {
  "claude-code": () => new ClaudeCodeAdapter(),
  codex: () => new CodexAdapter(),
  "codex-cli": () => new CodexAdapter(),
};

const TARGETS: Record<string, () => TargetAdapter> = {
  codex: () => new CodexAdapter(),
  "codex-cli": () => new CodexAdapter(),
  "claude-code": () => new ClaudeCodeAdapter(),
};

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith("--")) continue;
    const body = a.slice(2);
    // Support --key=value form (GNU long option style).
    const eq = body.indexOf("=");
    if (eq >= 0) {
      const key = body.slice(0, eq);
      const value = body.slice(eq + 1);
      if (key.length === 0) continue;
      out[key] = value;
      continue;
    }
    const key = body;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}


async function main() {
  const [, , sub, ...rest] = process.argv;
  const args = parseArgs(rest);

  switch (sub) {
    case "export": {
      const source = pickSource(requireArg(args, "from"));
      let ctx = await source.extract(requireArg(args, "session"));
      if (args.redact) ctx = redactContext(ctx);
      const json = JSON.stringify(ctx, null, 2);
      if (args.out === true) {
        throw new Error("--out requires a file path (got bare flag)");
      }
      if (typeof args.out === "string") {
        await fs.writeFile(args.out, json, "utf8");
        console.error(
          `Wrote ${args.out} (${ctx.messages.length} messages` +
            (args.redact ? ", redacted" : "") +
            `)`,
        );
      } else {
        process.stdout.write(json + "\n");
      }
      break;
    }
    case "import": {
      const target = pickTarget(requireArg(args, "to"));
      const inPath = typeof args.in === "string" ? args.in : "/dev/stdin";
      const raw = await fs.readFile(inPath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new Error(
          `Invalid JSON in --in: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Auto-detect: .cbctx package vs raw NormalizedContext export.
      if (isCbctxPackage(parsed)) {
        const { result, summary } = await importPackage(inPath, target, {
          skipDoctor: args["skip-doctor"] === true,
          redactAdditional: args.redact === true,
          keepSourceCwd: args["keep-source-cwd"] === true,
          receiverCwd: typeof args.cwd === "string" ? args.cwd : undefined,
          skipHashVerify: args["skip-hash-verify"] === true,
        });
        process.stderr.write(formatImportSummary(summary));
        console.error(`Injected to: ${result.locator}`);
        console.error(result.hint);
      } else {
        // Raw NormalizedContext JSON path — note that this format does NOT
        // carry a contentHash. The receiver has no way to detect tampering;
        // make that visible at the terminal.
        console.error(
          "WARNING: input is raw NormalizedContext JSON without a contentHash. " +
            "Integrity cannot be verified. Use --in <file>.cbctx for hash-checked imports.",
        );
        let ctx = parsed as NormalizedContext;
        if (args.redact) ctx = redactContext(ctx);
        const result = await target.inject(ctx);
        console.error(`Injected to: ${result.locator}`);
        console.error(result.hint);
      }
      break;
    }
    case "share": {
      const source = pickSource(requireArg(args, "from"));
      let sessionId = typeof args.session === "string" ? args.session : "";
      if (!sessionId && args.latest) {
        const latest = await pickLatestSession(source);
        if (!latest) throw new Error(`No sessions found for source "${source.id}"`);
        sessionId = latest.id;
        console.error(
          `Latest ${source.id} session: ${latest.id}` +
            (latest.updatedAt ? `  (updated ${latest.updatedAt})` : ""),
        );
      }
      if (!sessionId) {
        throw new Error("share: provide --session <id> or --latest");
      }
      const ctx = await source.extract(sessionId);
      const { pkg } = await buildPackage(ctx, {
        redact: args.redact === true,
        includeRepoRef:
          args["include-repo-ref"] === true || args["include-patch"] === true,
        includePatch: args["include-patch"] === true,
        repoCwd: typeof args.cwd === "string" ? args.cwd : undefined,
      });
      const outPath =
        typeof args.out === "string"
          ? args.out
          : args.store === "stdout"
            ? "-"
            : defaultPackageName(pkg.source.sessionId);
      const written = await writePackage(pkg, outPath);
      if (written) {
        console.error(
          `Wrote ${written} (${pkg.messages.length} messages` +
            (pkg.redaction.enabled
              ? `, redacted: ${pkg.redaction.findings
                  .map((f) => `${f.kind}:${f.count}`)
                  .join(", ") || "none observed"}`
              : "") +
            (pkg.repo ? `, repo: ${pkg.repo.commit?.slice(0, 12) ?? "ref"}` : "") +
            ")",
        );
        console.error(``);
        console.error(`Share this file with your friend.`);
        console.error(`On their machine:`);
        console.error(
          `  can-bridge import --to <claude-code|codex> --in ${written}`,
        );
      }
      break;
    }
    case "pipe": {
      const source = pickSource(requireArg(args, "from"));
      let ctx = await source.extract(requireArg(args, "session"));
      if (args.redact) ctx = redactContext(ctx);
      if (args.verbose) {
        console.error(JSON.stringify(ctx, null, 2));
      }
      console.error(
        `Extracted ${ctx.messages.length} messages from ${ctx.source.tool}` +
          (ctx.source.model ? ` (${ctx.source.model})` : "") +
          (args.redact ? " — redacted" : ""),
      );
      if (args["as-prompt"]) {
        process.stdout.write(renderAsPrompt(ctx));
      } else {
        const target = pickTarget(requireArg(args, "to"));
        const result = await target.inject(ctx);
        console.error(`Injected to: ${result.locator}`);
        console.error(result.hint);
      }
      break;
    }
    case "list": {
      const source = pickSource(requireArg(args, "from"));
      if (!source.listSessions) {
        throw new Error(`Source "${source.id}" does not support list`);
      }
      let sessions = await source.listSessions();
      const cwdFilter =
        args.cwd === true
          ? process.cwd()
          : typeof args.cwd === "string"
            ? args.cwd
            : undefined;
      if (cwdFilter) {
        sessions = filterSessionsByCwd(sessions, cwdFilter);
      }
      const limit = args.all ? undefined : parsePositiveInteger(args.limit, 20);
      const sorted = sortSessionsNewestFirst(sessions);
      if (args.json) {
        const visible = typeof limit === "number" ? sorted.slice(0, limit) : sorted;
        process.stdout.write(JSON.stringify(visible, null, 2) + "\n");
      } else {
        process.stdout.write(formatSessionList(sorted, { limit }));
        const visibleCount =
          typeof limit === "number" ? Math.min(sorted.length, limit) : sorted.length;
        const suffix =
          typeof limit === "number" && sorted.length > visibleCount
            ? "; use --all or --limit <n> to show more"
            : "";
        console.error(`(${visibleCount}/${sorted.length} sessions${suffix})`);
      }
      break;
    }
    case "continue": {
      await runContinue(args);
      break;
    }
    case "doctor": {
      const result = await diagnoseSession(requireArg(args, "session"), {
        from: typeof args.from === "string" ? args.from : undefined,
      });
      if (args.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        process.stdout.write(formatDoctorResult(result));
      }
      if (result.status === "fail") process.exitCode = 1;
      break;
    }
    case "mailbox": {
      await runMailbox(rest);
      break;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${sub}`);
      printHelp();
      process.exit(1);
  }
}

async function runContinue(args: Record<string, string | boolean>) {
  const from = requireArg(args, "from");
  const to = requireArg(args, "to");
  const source = pickSource(from);
  const target = pickTarget(to);

  const session = args.latest
    ? await pickLatestSession(source)
    : typeof args.session === "string"
      ? { id: args.session }
      : null;
  if (!session) {
    throw new Error("Missing --session <id|path> or --latest");
  }

  if (args.latest) {
    console.error(
      `Selected latest ${from} session: ${session.id}` +
        (session.updatedAt ? ` (${session.updatedAt})` : ""),
    );
  }

  const doctor = await diagnoseSession(session.id, { from });
  if (doctor.status === "fail") {
    process.stderr.write(formatDoctorResult(doctor));
    throw new Error("Doctor preflight failed; not injecting target session");
  }
  if (args.verbose || doctor.status === "warn") {
    process.stderr.write(formatDoctorResult(doctor));
  } else {
    console.error(
      `Doctor ${doctor.detectedFormat}: ${doctor.status} (${doctor.score}/100)`,
    );
  }

  let ctx = await source.extract(session.id);
  if (args.redact) ctx = redactContext(ctx);
  console.error(
    `Extracted ${ctx.messages.length} messages from ${ctx.source.tool}` +
      (ctx.source.model ? ` (${ctx.source.model})` : "") +
      (args.redact ? " — redacted" : ""),
  );

  if (args["as-prompt"]) {
    process.stdout.write(renderAsPrompt(ctx));
    return;
  }

  const result = await target.inject(ctx);
  printContinueResult(to, result);
}

export async function pickLatestSession(
  source: SourceAdapter,
): Promise<SessionSummary> {
  if (!source.listSessions) {
    throw new Error(`Source "${source.id}" does not support --latest`);
  }
  const sessions = await source.listSessions();
  if (sessions.length === 0) {
    throw new Error(`No sessions found for source "${source.id}"`);
  }
  return sessions.reduce((latest, session) => {
    const latestTime = Date.parse(latest.updatedAt ?? "");
    const sessionTime = Date.parse(session.updatedAt ?? "");
    const latestNaN = Number.isNaN(latestTime);
    const sessionNaN = Number.isNaN(sessionTime);
    // Tie-break deterministically when timestamps are missing or equal:
    // pick the larger session id lexicographically. Without this the
    // result was input-order-dependent.
    if (latestNaN && sessionNaN) {
      return session.id > latest.id ? session : latest;
    }
    if (sessionNaN) return latest;
    if (latestNaN) return session;
    if (sessionTime === latestTime) {
      return session.id > latest.id ? session : latest;
    }
    return sessionTime > latestTime ? session : latest;
  });
}

export function formatSessionList(
  sessions: SessionSummary[],
  options: { limit?: number } = {},
): string {
  if (sessions.length === 0) return "(no sessions)\n";
  const visible =
    typeof options.limit === "number" ? sessions.slice(0, options.limit) : sessions;
  const lines: string[] = [];
  visible.forEach((session, index) => {
    const meta = [
      session.messageCount !== undefined
        ? `${session.messageCount} messages`
        : undefined,
      session.model ? `model: ${session.model}` : undefined,
    ].filter((v): v is string => Boolean(v));
    lines.push(
      `${index + 1}. ${formatUpdatedAt(session.updatedAt)}  ${session.id}` +
        (meta.length > 0 ? `  (${meta.join(", ")})` : ""),
    );
    if (session.cwd) {
      lines.push(`   project: ${projectName(session.cwd)}`);
      lines.push(`   cwd: ${session.cwd}`);
    }
    if (session.title) {
      lines.push(`   latest user: "${session.title}"`);
    }
  });
  return lines.join("\n") + "\n";
}

function sortSessionsNewestFirst(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    const at = Date.parse(a.updatedAt ?? "");
    const bt = Date.parse(b.updatedAt ?? "");
    const aNaN = Number.isNaN(at);
    const bNaN = Number.isNaN(bt);
    if (aNaN && bNaN) return b.id.localeCompare(a.id);
    if (aNaN) return 1;
    if (bNaN) return -1;
    if (bt === at) return b.id.localeCompare(a.id);
    return bt - at;
  });
}

function filterSessionsByCwd(
  sessions: SessionSummary[],
  cwd: string,
): SessionSummary[] {
  const expected = normalizePathForCompare(cwd);
  return sessions.filter((session) => {
    if (!session.cwd) return false;
    return normalizePathForCompare(session.cwd) === expected;
  });
}

function normalizePathForCompare(value: string): string {
  return path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function parsePositiveInteger(
  value: string | boolean | undefined,
  fallback: number,
): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--limit must be a positive integer (got "${value}")`);
  }
  return parsed;
}

function formatUpdatedAt(value: string | undefined): string {
  if (!value) return "unknown-time";
  return value.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function projectName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]+/);
  return parts[parts.length - 1] || cwd;
}

function printContinueResult(to: string, result: InjectionResult) {
  console.error(`Injected to: ${result.locator}`);
  const sessionId =
    typeof result.details?.sessionId === "string"
      ? result.details.sessionId
      : undefined;
  if ((to === "codex" || to === "codex-cli") && sessionId) {
    console.error("");
    console.error("Next:");
    console.error(`  codex resume ${sessionId}`);
    console.error("");
    console.error("Or one non-interactive turn:");
    console.error(
      `  codex exec --skip-git-repo-check resume ${sessionId} "<your prompt>"`,
    );
    return;
  }
  console.error(result.hint);
}

async function runMailbox(argv: string[]) {
  const [action, ...rest] = argv;
  const args = parseArgs(rest);
  const mailboxPath = typeof args.mailbox === "string" ? args.mailbox : undefined;

  switch (action) {
    case "send": {
      const from = requireArg(args, "from");
      const to = requireArg(args, "to");
      const body = await readBody(args);
      const message = await sendMessage({
        from,
        to,
        body,
        mailboxPath,
        threadId: typeof args.thread === "string" ? args.thread : undefined,
        subject: typeof args.subject === "string" ? args.subject : undefined,
        replyTo: typeof args["reply-to"] === "string" ? args["reply-to"] : undefined,
      });
      console.error(`Sent ${message.id} to ${message.to}`);
      console.error(`Thread ${message.threadId}`);
      break;
    }
    case "inbox": {
      const agent = requireArg(args, "agent");
      const messages = await listInbox(agent, mailboxPath);
      process.stdout.write(formatMessages(messages));
      break;
    }
    case "thread": {
      const threadId = requireArg(args, "thread");
      const messages = await listThread(threadId, mailboxPath);
      process.stdout.write(formatMessages(messages));
      break;
    }
    case "all": {
      const messages = await readMessages(mailboxPath);
      process.stdout.write(formatMessages(messages));
      break;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printMailboxHelp();
      break;
    default:
      throw new Error(`Unknown mailbox command: ${action}`);
  }
}

function requireArg(args: Record<string, string | boolean>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing --${key}`);
  }
  return value;
}

async function readBody(args: Record<string, string | boolean>): Promise<string> {
  if (typeof args.body === "string") return args.body;
  if (typeof args["body-file"] === "string") {
    return await fs.readFile(args["body-file"], "utf8");
  }
  throw new Error("Missing --body or --body-file");
}

function pickSource(id: string): SourceAdapter {
  const factory = SOURCES[id];
  if (!factory) {
    throw new Error(
      `Unknown source "${id}". Available: ${Object.keys(SOURCES).join(", ")}`,
    );
  }
  return factory();
}

function pickTarget(id: string): TargetAdapter {
  const factory = TARGETS[id];
  if (!factory) {
    throw new Error(
      `Unknown target "${id}". Available: ${Object.keys(TARGETS).join(", ")}`,
    );
  }
  return factory();
}

function renderAsPrompt(ctx: NormalizedContext): string {
  const lines: string[] = [];
  lines.push(UNTRUSTED_FENCE_HEADER);
  lines.push("");
  lines.push(
    `# Imported conversation from ${ctx.source.tool}` +
      (ctx.source.model ? ` (model: ${ctx.source.model})` : ""),
  );
  if (ctx.source.sessionId) {
    lines.push(`Original session: ${ctx.source.sessionId}`);
  }
  if (ctx.summary) {
    lines.push("");
    lines.push("## Summary");
    lines.push(ctx.summary);
  }
  lines.push("");
  lines.push("## Transcript");
  for (const m of ctx.messages) {
    lines.push("");
    lines.push(`### ${m.role}`);
    for (const b of m.content) {
      if (b.type === "text") lines.push(b.text);
      else if (b.type === "thinking") continue;
      else if (b.type === "tool_use")
        lines.push(`[tool_use ${b.name}] ${JSON.stringify(b.input)}`);
      else if (b.type === "tool_result")
        lines.push(`[tool_result${b.isError ? " (error)" : ""}] ${b.output}`);
    }
  }
  lines.push("");
  lines.push(
    "Please continue this conversation. Pick up where the assistant left off.",
  );
  return lines.join("\n") + "\n";
}

function printHelp() {
  process.stderr.write(`can-bridge — portable context handoff for Claude Code and Codex CLI

Commands:
  continue --from <source> --to <target> (--latest | --session <id>) [--redact] [--as-prompt]
  export --from <source> --session <id> [--out file.json] [--redact]
  import --to <target> --in file.{json,cbctx} [--redact] [--skip-doctor] [--skip-hash-verify]
  pipe   --from <source> --session <id> --to <target> [--as-prompt] [--redact] [--verbose]
  list   --from <source> [--cwd [path]] [--limit n | --all] [--json]
  doctor --from <source> --session <id|path> [--json]
  share  --from <source> (--session <id> | --latest) [--redact] [--include-repo-ref]
                         [--include-patch] [--out file.cbctx | --store stdout]
  mailbox <send|inbox|thread|all>

Flags:
  --redact   Mask common API keys (sk-, sk-ant-, gh*_, AKIA, AIza, xox*-),
             JWTs, Bearer tokens, and password=/token= values with
             [REDACTED:<kind>]. Opt-in.

Sources: ${Object.keys(SOURCES).join(", ")}
Targets: ${Object.keys(TARGETS).join(", ")}
`);
}

function printMailboxHelp() {
  process.stderr.write(`can-bridge mailbox — local agent-to-agent message queue

Commands:
  mailbox send --from <agent> --to <agent> --body <text> [--thread <id>] [--subject <text>] [--reply-to <id>]
  mailbox send --from <agent> --to <agent> --body-file <path> [--thread <id>]
  mailbox inbox --agent <agent>
  mailbox thread --thread <id>
  mailbox all

Flags:
  --mailbox <path>   Override the default .agent-chat/messages.jsonl path.
`);
}

function sameEntrypoint(a: string, b: string): boolean {
  const pa = path.resolve(a);
  const pb = path.resolve(b);
  if (pa === pb) return true;
  try {
    return realpathSync.native(pa) === realpathSync.native(pb);
  } catch {
    return false;
  }
}

const isDirectRun = process.argv[1]
  ? sameEntrypoint(fileURLToPath(import.meta.url), process.argv[1])
  : false;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
