#!/usr/bin/env node
/**
 * harness — LLM Context Harness CLI
 *
 * Usage:
 *   harness export --from claude-code --session <id|path> [--out file.json]
 *   harness import --to codex --in file.json
 *   harness pipe   --from claude-code --session <id> --to codex
 *   harness pipe   --from claude-code --session <id> --to codex --as-prompt
 *   harness list   --from claude-code
 */

import { promises as fs } from "node:fs";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { CodexAdapter } from "../adapters/codex.js";
import type { SourceAdapter, TargetAdapter } from "../adapters/base.js";
import {
  formatMessages,
  listInbox,
  listThread,
  readMessages,
  sendMessage,
} from "../collab/mailbox.js";
import type { NormalizedContext } from "../schema/context.js";
import { redactContext } from "../transform/redactor.js";

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
    const key = a.slice(2);
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
      const source = pickSource(String(args.from ?? ""));
      let ctx = await source.extract(String(args.session ?? ""));
      if (args.redact) ctx = redactContext(ctx);
      const json = JSON.stringify(ctx, null, 2);
      if (args.out) {
        await fs.writeFile(String(args.out), json, "utf8");
        console.error(
          `Wrote ${String(args.out)} (${ctx.messages.length} messages` +
            (args.redact ? ", redacted" : "") +
            `)`,
        );
      } else {
        process.stdout.write(json + "\n");
      }
      break;
    }
    case "import": {
      const target = pickTarget(String(args.to ?? ""));
      const raw = await fs.readFile(String(args.in ?? "/dev/stdin"), "utf8");
      let ctx = JSON.parse(raw) as NormalizedContext;
      if (args.redact) ctx = redactContext(ctx);
      const result = await target.inject(ctx);
      console.error(`Injected to: ${result.locator}`);
      console.error(result.hint);
      break;
    }
    case "pipe": {
      const source = pickSource(String(args.from ?? ""));
      let ctx = await source.extract(String(args.session ?? ""));
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
        const target = pickTarget(String(args.to ?? ""));
        const result = await target.inject(ctx);
        console.error(`Injected to: ${result.locator}`);
        console.error(result.hint);
      }
      break;
    }
    case "list": {
      const source = pickSource(String(args.from ?? ""));
      if (!source.listSessions) {
        throw new Error(`Source "${source.id}" does not support list`);
      }
      const sessions = await source.listSessions();
      for (const s of sessions) {
        process.stdout.write(`${s.id}\t${s.updatedAt ?? ""}\n`);
      }
      console.error(`(${sessions.length} sessions)`);
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
  process.stderr.write(`harness — LLM Context Harness

Commands:
  export --from <source> --session <id> [--out file.json] [--redact]
  import --to <target> --in file.json [--redact]
  pipe   --from <source> --session <id> --to <target> [--as-prompt] [--redact] [--verbose]
  list   --from <source>
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
  process.stderr.write(`harness mailbox — local agent-to-agent message queue

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

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
