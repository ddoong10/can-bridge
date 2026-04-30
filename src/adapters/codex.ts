import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type {
  SourceAdapter,
  TargetAdapter,
  InjectionResult,
} from "./base.js";
import type {
  NormalizedContext,
  NormalizedMessage,
  ContentBlock,
  Role,
} from "../schema/context.js";

/**
 * Codex CLI sessions live at:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *
 * Verified line shapes (2026-04-30, Codex CLI 0.125.0):
 *
 *   {timestamp, type:"session_meta",
 *    payload:{id, timestamp, cwd, originator, cli_version, source,
 *             model_provider, base_instructions:{text}}}
 *
 *   {timestamp, type:"response_item",
 *    payload:{type:"message", role:"user"|"assistant"|"developer",
 *             content:[{type:"input_text"|"output_text", text}]}}
 *
 *   {timestamp, type:"response_item",
 *    payload:{type:"function_call", name, arguments:string-JSON, call_id}}
 *
 *   {timestamp, type:"response_item",
 *    payload:{type:"function_call_output", call_id, output:string}}
 *
 *   {timestamp, type:"event_msg", payload:{type:"user_message"|"task_started"|
 *             "task_complete"|"token_count"|"error", ...}}
 *
 *   {timestamp, type:"turn_context", payload:{model, reasoning_effort, ...}}
 */

const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

export class CodexAdapter implements SourceAdapter, TargetAdapter {
  readonly id = "codex";

  // ─── SourceAdapter ────────────────────────────────────────────────

  async extract(locator: string): Promise<NormalizedContext> {
    const filePath = await this.resolveSessionPath(locator);
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    const messages: NormalizedMessage[] = [];
    let sessionId: string | undefined;
    let model: string | undefined;
    let capturedAt: string | undefined;
    let cwd: string | undefined;
    let summary: string | undefined;

    for (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = entry.type;
      const payload = entry.payload as Record<string, unknown> | undefined;
      const ts =
        typeof entry.timestamp === "string" ? entry.timestamp : undefined;
      capturedAt ??= ts;

      if (type === "session_meta" && payload) {
        if (typeof payload.id === "string") sessionId = payload.id;
        if (typeof payload.cwd === "string") cwd = payload.cwd;
        const bi = payload.base_instructions as
          | { text?: string }
          | undefined;
        if (bi && typeof bi.text === "string" && bi.text.length > 0) {
          summary ??= bi.text;
        }
        continue;
      }
      if (type === "turn_context" && payload) {
        if (typeof payload.model === "string") model ??= payload.model;
        continue;
      }
      if (type === "response_item" && payload) {
        const msg = responseItemToMessage(payload, ts);
        if (msg) messages.push(msg);
        continue;
      }
      // event_msg, etc → skip (user_message duplicates response_item;
      // task_started/complete/token_count are runtime events).
    }

    return {
      schemaVersion: "0.1",
      source: { tool: "codex", model, sessionId, capturedAt, cwd },
      summary,
      messages,
      metadata: { sourceFile: filePath },
    };
  }

  async listSessions() {
    const out: { id: string; updatedAt?: string }[] = [];
    await walkRollouts(CODEX_SESSIONS_DIR, async (file, stat) => {
      const m = file.match(/-([0-9a-f-]{36})\.jsonl$/i);
      if (m && m[1]) out.push({ id: m[1], updatedAt: stat.mtime.toISOString() });
    });
    return out;
  }

  private async resolveSessionPath(locator: string): Promise<string> {
    if (!locator) {
      throw new Error("codex: --session is required (UUID or .jsonl path)");
    }
    if (locator.endsWith(".jsonl")) return locator;
    let found: string | null = null;
    await walkRollouts(CODEX_SESSIONS_DIR, async (file, _stat, fullPath) => {
      if (!found && file.includes(locator)) found = fullPath;
    });
    if (found) return found;
    throw new Error(
      `Could not find Codex rollout for "${locator}" under ${CODEX_SESSIONS_DIR}`,
    );
  }

  // ─── TargetAdapter ────────────────────────────────────────────────

  async inject(context: NormalizedContext): Promise<InjectionResult> {
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    const dir = path.join(CODEX_SESSIONS_DIR, yyyy, mm, dd);
    await fs.mkdir(dir, { recursive: true });

    const sessionId = crypto.randomUUID();
    const ts = now.toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(dir, `rollout-${ts}-${sessionId}.jsonl`);

    const lines = buildCodexJsonl(context, sessionId, now);
    await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");

    return {
      locator: filePath,
      hint:
        `Resume in a real terminal (TUI):\n` +
        `  codex resume ${sessionId}\n` +
        `\n` +
        `Or run a single non-interactive turn (verified working):\n` +
        `  codex exec --skip-git-repo-check resume ${sessionId} "<your prompt>"\n` +
        `\n` +
        `If resume rejects the file (rare; format may have changed), use the prompt fallback:\n` +
        `  harness pipe --from <src> --session <id> --to codex --as-prompt > seed.md\n` +
        `\n` +
        `Note: a stderr line "thread <uuid> not found" on first resume is cosmetic — see docs/OPEN_QUESTIONS.md.`,
      details: { sessionId, filePath },
    };
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

async function walkRollouts(
  root: string,
  visit: (file: string, stat: import("node:fs").Stats, fullPath: string) => Promise<void>,
): Promise<void> {
  let years: string[];
  try {
    years = await fs.readdir(root);
  } catch {
    return;
  }
  for (const y of years) {
    const yPath = path.join(root, y);
    let months: string[];
    try {
      months = await fs.readdir(yPath);
    } catch {
      continue;
    }
    for (const m of months) {
      const mPath = path.join(yPath, m);
      let days: string[];
      try {
        days = await fs.readdir(mPath);
      } catch {
        continue;
      }
      for (const d of days) {
        const dPath = path.join(mPath, d);
        let files: string[];
        try {
          files = await fs.readdir(dPath);
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
          const full = path.join(dPath, f);
          const stat = await fs.stat(full);
          await visit(f, stat, full);
        }
      }
    }
  }
}

function responseItemToMessage(
  payload: Record<string, unknown>,
  ts: string | undefined,
): NormalizedMessage | null {
  const itemType = payload.type;

  if (itemType === "message") {
    const role = payload.role;
    const content = payload.content;
    if (!Array.isArray(content)) return null;
    let normRole: Role;
    if (role === "user") normRole = "user";
    else if (role === "assistant") normRole = "assistant";
    else if (role === "developer" || role === "system") normRole = "system";
    else return null;
    const blocks: ContentBlock[] = [];
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      const cb = c as Record<string, unknown>;
      const t = cb.type;
      if (
        (t === "input_text" || t === "output_text") &&
        typeof cb.text === "string" &&
        cb.text.length > 0
      ) {
        blocks.push({ type: "text", text: cb.text });
      }
    }
    if (blocks.length === 0) return null;
    return { role: normRole, content: blocks, timestamp: ts };
  }

  if (itemType === "function_call") {
    const callId =
      typeof payload.call_id === "string" ? payload.call_id : undefined;
    const name =
      typeof payload.name === "string" ? payload.name : "unknown";
    let input: unknown = undefined;
    if (typeof payload.arguments === "string") {
      try {
        input = JSON.parse(payload.arguments);
      } catch {
        input = payload.arguments;
      }
    } else {
      input = payload.arguments;
    }
    return {
      role: "assistant",
      content: [{ type: "tool_use", id: callId, name, input }],
      timestamp: ts,
    };
  }

  if (itemType === "function_call_output") {
    const callId =
      typeof payload.call_id === "string" ? payload.call_id : undefined;
    const output =
      typeof payload.output === "string"
        ? payload.output
        : JSON.stringify(payload.output);
    return {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: callId, output, isError: false },
      ],
      timestamp: ts,
    };
  }

  return null;
}

function buildCodexJsonl(
  context: NormalizedContext,
  sessionId: string,
  now: Date,
): string[] {
  const out: string[] = [];
  const ts = now.toISOString();
  const cwd = context.source.cwd ?? process.cwd();

  out.push(
    JSON.stringify({
      timestamp: ts,
      type: "session_meta",
      payload: {
        id: sessionId,
        timestamp: ts,
        cwd,
        originator: "llm-context-harness",
        cli_version: "0.0.1",
        source: "harness-import",
        model_provider: "openai",
        base_instructions: { text: buildBaseInstructions(context) },
      },
    }),
  );

  for (const msg of context.messages) {
    const items = messageToResponseItems(msg);
    for (const item of items) {
      out.push(
        JSON.stringify({
          timestamp: msg.timestamp ?? ts,
          type: "response_item",
          payload: item,
        }),
      );
    }
    if (msg.role === "user") {
      const text = textOf(msg);
      if (text) {
        out.push(
          JSON.stringify({
            timestamp: msg.timestamp ?? ts,
            type: "event_msg",
            payload: {
              type: "user_message",
              message: text,
              images: [],
              local_images: [],
              text_elements: [],
            },
          }),
        );
      }
    }
  }
  return out;
}

function buildBaseInstructions(ctx: NormalizedContext): string {
  const lines: string[] = [];
  lines.push(
    `This session was imported from ${ctx.source.tool}` +
      (ctx.source.model ? ` (original model: ${ctx.source.model})` : "") +
      ".",
  );
  if (ctx.source.sessionId) {
    lines.push(`Original session id: ${ctx.source.sessionId}`);
  }
  if (ctx.summary) {
    lines.push("");
    lines.push("Summary of prior conversation:");
    lines.push(ctx.summary);
  }
  return lines.join("\n");
}

function messageToResponseItems(msg: NormalizedMessage): unknown[] {
  const items: unknown[] = [];

  // 1. Plain text (and optional thinking) → one message item.
  const textChunks: string[] = [];
  for (const b of msg.content) {
    if (b.type === "text") textChunks.push(b.text);
    // thinking blocks deliberately dropped — internal to source model.
  }
  if (textChunks.length > 0) {
    let role: "user" | "assistant" | "developer" = "user";
    if (msg.role === "assistant") role = "assistant";
    else if (msg.role === "system") role = "developer";
    const blockType = role === "assistant" ? "output_text" : "input_text";
    items.push({
      type: "message",
      role,
      content: [{ type: blockType, text: textChunks.join("\n\n") }],
    });
  }

  // 2. Each tool_use → function_call item.
  for (const b of msg.content) {
    if (b.type === "tool_use") {
      items.push({
        type: "function_call",
        name: b.name,
        arguments:
          typeof b.input === "string"
            ? b.input
            : JSON.stringify(b.input ?? {}),
        call_id: b.id ?? `call_${crypto.randomUUID().replace(/-/g, "")}`,
      });
    }
  }

  // 3. Each tool_result → function_call_output item.
  for (const b of msg.content) {
    if (b.type === "tool_result") {
      const prefix = b.isError ? "[error] " : "";
      items.push({
        type: "function_call_output",
        call_id: b.toolUseId ?? "",
        output: prefix + b.output,
      });
    }
  }

  return items;
}

function textOf(msg: NormalizedMessage): string {
  return msg.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> =>
      b.type === "text",
    )
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}
