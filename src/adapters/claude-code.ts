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
} from "../schema/context.js";

/**
 * Claude Code stores each session as a JSONL file at:
 *   ~/.claude/projects/<project-folder>/<session-uuid>.jsonl
 *
 * The project folder is derived from the absolute cwd by replacing each
 * of `:`, `\\`, `/`, `_` with `-` (verified for Windows: cwd
 * `C:\Users\ddoon\Desktop\context_switching` →
 * folder `C--Users-ddoon-Desktop-context-switching`).
 *
 * Wrapper line shape (relevant fields):
 *   { type, uuid, parentUuid, timestamp, sessionId, cwd, gitBranch, version,
 *     message?: { role, model?, content }, attachment?: {...} }
 *
 * type values observed: permission-mode, attachment, user, assistant,
 * file-history-snapshot. Only user/assistant lines carry transcript content.
 *
 * One assistant turn can be split across multiple JSONL lines that share
 * `message.id`. The extractor coalesces them by id.
 */

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const IGNORED_TYPES = new Set([
  "permission-mode",
  "attachment",
  "file-history-snapshot",
]);

export class ClaudeCodeAdapter implements SourceAdapter, TargetAdapter {
  readonly id = "claude-code";

  // ─── SourceAdapter ────────────────────────────────────────────────

  async extract(locator: string): Promise<NormalizedContext> {
    const filePath = await this.resolveSessionPath(locator);
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    const messagesById = new Map<string, NormalizedMessage>();
    const orderedMessages: NormalizedMessage[] = [];
    let sessionId: string | undefined;
    let model: string | undefined;
    let firstTimestamp: string | undefined;
    let cwd: string | undefined;

    for (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch (err) {
        console.warn(`[claude-code] skipping malformed line: ${err}`);
        continue;
      }

      const type = entry.type;
      if (typeof type !== "string") continue;

      if (typeof entry.sessionId === "string") sessionId ??= entry.sessionId;
      if (typeof entry.cwd === "string") cwd ??= entry.cwd;
      if (typeof entry.timestamp === "string") {
        firstTimestamp ??= entry.timestamp;
      }

      if (IGNORED_TYPES.has(type)) continue;
      if (type !== "user" && type !== "assistant") continue;

      const msg = entry.message as
        | { id?: string; role?: string; model?: string; content?: unknown }
        | undefined;
      if (!msg) continue;

      if (typeof msg.model === "string") model ??= msg.model;

      const role =
        msg.role === "user" || msg.role === "assistant"
          ? msg.role
          : (type as "user" | "assistant");

      const blocks = normalizeContent(msg.content);
      if (blocks.length === 0) continue;

      const messageId = typeof msg.id === "string" ? msg.id : undefined;
      const timestamp =
        typeof entry.timestamp === "string" ? entry.timestamp : undefined;

      if (messageId && messagesById.has(messageId)) {
        const existing = messagesById.get(messageId)!;
        existing.content.push(...blocks);
        continue;
      }

      const normalized: NormalizedMessage = {
        role,
        content: blocks,
        timestamp,
        metadata: {
          uuid: entry.uuid,
          parentUuid: entry.parentUuid,
          messageId,
        },
      };
      orderedMessages.push(normalized);
      if (messageId) messagesById.set(messageId, normalized);
    }

    return {
      schemaVersion: "0.1",
      source: {
        tool: "claude-code",
        model,
        sessionId,
        capturedAt: firstTimestamp,
        cwd,
      },
      messages: orderedMessages,
      metadata: { sourceFile: filePath },
    };
  }

  async listSessions() {
    const out: { id: string; updatedAt?: string }[] = [];
    let projectDirs: string[];
    try {
      projectDirs = await fs.readdir(CLAUDE_PROJECTS_DIR);
    } catch {
      return out;
    }
    for (const dir of projectDirs) {
      const full = path.join(CLAUDE_PROJECTS_DIR, dir);
      let entries: string[];
      try {
        entries = await fs.readdir(full);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith(".jsonl")) continue;
        const stat = await fs.stat(path.join(full, f));
        out.push({
          id: f.replace(/\.jsonl$/, ""),
          updatedAt: stat.mtime.toISOString(),
        });
      }
    }
    return out;
  }

  private async resolveSessionPath(locator: string): Promise<string> {
    if (!locator) {
      throw new Error("claude-code: --session is required (id or .jsonl path)");
    }
    if (locator.endsWith(".jsonl")) return locator;
    const projectDirs = await fs.readdir(CLAUDE_PROJECTS_DIR);
    for (const dir of projectDirs) {
      const candidate = path.join(
        CLAUDE_PROJECTS_DIR,
        dir,
        `${locator}.jsonl`,
      );
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // try next
      }
    }
    throw new Error(
      `Could not find Claude Code session "${locator}" under ${CLAUDE_PROJECTS_DIR}`,
    );
  }

  // ─── TargetAdapter ────────────────────────────────────────────────

  async inject(context: NormalizedContext): Promise<InjectionResult> {
    const cwd = context.source.cwd ?? process.cwd();
    const folder = cwdToProjectFolder(cwd);
    const dir = path.join(CLAUDE_PROJECTS_DIR, folder);
    await fs.mkdir(dir, { recursive: true });

    const sessionId = crypto.randomUUID();
    const filePath = path.join(dir, `${sessionId}.jsonl`);

    const lines = buildClaudeJsonl(context, sessionId, cwd);
    await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");

    return {
      locator: filePath,
      hint:
        `Resume in Claude Code (interactive picker by cwd):\n` +
        `  cd "${cwd}"\n` +
        `  claude --resume\n` +
        `\n` +
        `Then choose the session whose first message is your imported one.\n` +
        `Auto-resume by id is not exposed by current Claude Code versions.`,
      details: { sessionId, filePath, projectFolder: folder },
    };
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * Convert `C:\\Users\\ddoon\\Desktop\\context_switching` →
 * `C--Users-ddoon-Desktop-context-switching`.
 *
 * Verified rule: each of `:`, `\\`, `/`, `_` is replaced by `-`.
 */
function cwdToProjectFolder(cwd: string): string {
  return cwd.replace(/[:\\\/_]/g, "-");
}

function normalizeContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks: ContentBlock[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    const t = b.type;
    if (t === "text" && typeof b.text === "string") {
      if (b.text.length > 0) blocks.push({ type: "text", text: b.text });
    } else if (t === "thinking" && typeof b.thinking === "string") {
      if (b.thinking.length > 0) {
        blocks.push({ type: "thinking", text: b.thinking });
      }
    } else if (t === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: typeof b.id === "string" ? b.id : undefined,
        name: typeof b.name === "string" ? b.name : "unknown",
        input: b.input,
      });
    } else if (t === "tool_result") {
      const rawContent = b.content;
      const output =
        typeof rawContent === "string"
          ? rawContent
          : JSON.stringify(rawContent);
      blocks.push({
        type: "tool_result",
        toolUseId:
          typeof b.tool_use_id === "string" ? b.tool_use_id : undefined,
        output,
        isError: b.is_error === true,
      });
    } else {
      console.warn(`[claude-code] unknown content block type: ${String(t)}`);
      blocks.push({ type: "text", text: JSON.stringify(b) });
    }
  }
  return blocks;
}

function buildClaudeJsonl(
  context: NormalizedContext,
  sessionId: string,
  cwd: string,
): string[] {
  const out: string[] = [];
  let prevUuid: string | null = null;
  const fallbackTs = new Date().toISOString();

  for (const msg of context.messages) {
    const uuid = crypto.randomUUID();
    const wrapper = {
      parentUuid: prevUuid,
      isSidechain: false,
      userType: "external",
      entrypoint: "cli",
      type: msg.role === "assistant" ? "assistant" : "user",
      uuid,
      timestamp: msg.timestamp ?? fallbackTs,
      sessionId,
      cwd,
      version: "harness/0.0.1",
      message: messageToClaudeContent(msg),
    };
    out.push(JSON.stringify(wrapper));
    prevUuid = uuid;
  }
  return out;
}

function messageToClaudeContent(
  msg: NormalizedMessage,
): { role: string; content: unknown } {
  // Anthropic rules:
  //  - assistant content: array of {text|thinking|tool_use} blocks
  //  - user content: string OR array of {text|tool_result} blocks
  if (msg.role === "assistant") {
    const content = msg.content
      .map((b): unknown => {
        if (b.type === "text") return { type: "text", text: b.text };
        if (b.type === "thinking") {
          return { type: "thinking", thinking: b.text, signature: "" };
        }
        if (b.type === "tool_use") {
          return {
            type: "tool_use",
            id: b.id ?? `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
            name: b.name,
            input: b.input ?? {},
          };
        }
        // tool_result doesn't belong on assistant messages — drop.
        return null;
      })
      .filter((x) => x !== null);
    return { role: "assistant", content };
  }

  // user — string when all-text, otherwise array.
  const allText = msg.content.every((b) => b.type === "text");
  if (allText) {
    return {
      role: "user",
      content: msg.content
        .filter(
          (b): b is Extract<ContentBlock, { type: "text" }> =>
            b.type === "text",
        )
        .map((b) => b.text)
        .join("\n\n"),
    };
  }
  const content = msg.content
    .map((b): unknown => {
      if (b.type === "text") return { type: "text", text: b.text };
      if (b.type === "tool_result") {
        return {
          type: "tool_result",
          tool_use_id: b.toolUseId ?? "",
          content: b.output,
          is_error: b.isError === true,
        };
      }
      // tool_use / thinking don't belong on user messages — drop.
      return null;
    })
    .filter((x) => x !== null);
  return { role: "user", content };
}
