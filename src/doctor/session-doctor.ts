import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { NormalizedContext } from "../schema/context.js";

type FormatId = "claude-code" | "codex" | "unknown";
type FindingLevel = "error" | "warn" | "info";

export interface DoctorOptions {
  from?: string;
}

export interface DoctorFinding {
  level: FindingLevel;
  code: string;
  message: string;
  line?: number;
}

export interface DoctorResult {
  filePath: string;
  expectedFormat?: FormatId;
  detectedFormat: FormatId;
  status: "ok" | "warn" | "fail";
  score: number;
  lineCount: number;
  parsedLineCount: number;
  findings: DoctorFinding[];
}

interface ParsedLine {
  line: number;
  value: Record<string, unknown>;
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

const CLAUDE_TYPES = new Set([
  "user",
  "assistant",
  "permission-mode",
  "attachment",
  "file-history-snapshot",
  "last-prompt",
  "queue-operation",
  "system",
]);

const CODEX_WRAPPER_TYPES = new Set([
  "session_meta",
  "response_item",
  "event_msg",
  "turn_context",
]);

const CODEX_RESPONSE_ITEM_TYPES = new Set([
  "message",
  "function_call",
  "function_call_output",
  "reasoning",
  "web_search_call",
]);

export async function diagnoseSession(
  locator: string,
  options: DoctorOptions = {},
): Promise<DoctorResult> {
  if (!locator) throw new Error("doctor: --session is required");
  const expectedFormat = normalizeFormat(options.from);
  const filePath = await resolveSessionPath(locator, expectedFormat);
  const raw = await fs.readFile(filePath, "utf8");
  const rawLines = raw.split(/\r?\n/);
  const findings: DoctorFinding[] = [];
  const parsed: ParsedLine[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const lineText = rawLines[i];
    if (!lineText || lineText.trim().length === 0) continue;
    try {
      const value = JSON.parse(lineText) as unknown;
      if (isRecord(value)) {
        parsed.push({ line: i + 1, value });
      } else {
        findings.push({
          level: "error",
          code: "JSON_NOT_OBJECT",
          message: "JSONL line must parse to an object",
          line: i + 1,
        });
      }
    } catch (err) {
      findings.push({
        level: "error",
        code: "JSON_PARSE_ERROR",
        message: err instanceof Error ? err.message : String(err),
        line: i + 1,
      });
    }
  }

  if (parsed.length === 0) {
    findings.push({
      level: "error",
      code: "NO_PARSEABLE_LINES",
      message: "No parseable JSON object lines found",
    });
  }

  const detectedFormat = detectFormat(parsed);
  const formatToValidate =
    expectedFormat && expectedFormat !== "unknown" ? expectedFormat : detectedFormat;

  if (
    expectedFormat &&
    expectedFormat !== "unknown" &&
    detectedFormat !== "unknown" &&
    detectedFormat !== expectedFormat
  ) {
    findings.push({
      level: "error",
      code: "FORMAT_MISMATCH",
      message: `Expected ${expectedFormat}, detected ${detectedFormat}`,
    });
  }

  if (formatToValidate === "claude-code") {
    validateClaude(parsed, findings);
  } else if (formatToValidate === "codex") {
    validateCodex(parsed, findings);
  } else {
    findings.push({
      level: "error",
      code: "UNKNOWN_FORMAT",
      message: "Could not detect a supported session format",
    });
  }

  const score = scoreFindings(findings);
  const status =
    findings.some((f) => f.level === "error")
      ? "fail"
      : findings.some((f) => f.level === "warn")
        ? "warn"
        : "ok";

  return {
    filePath,
    expectedFormat,
    detectedFormat,
    status,
    score,
    lineCount: rawLines.filter((l) => l.trim().length > 0).length,
    parsedLineCount: parsed.length,
    findings,
  };
}

/**
 * Lightweight, in-memory variant of {@link diagnoseSession} for callers
 * that already have a `NormalizedContext` (e.g. share/import). Validates
 * structural invariants of messages/blocks instead of raw JSONL.
 */
export async function diagnoseSessionFromContext(
  ctx: NormalizedContext,
): Promise<DoctorResult> {
  const findings: DoctorFinding[] = [];
  const validRoles = new Set(["user", "assistant", "system", "tool"]);
  const validBlocks = new Set(["text", "thinking", "tool_use", "tool_result"]);

  if (ctx.messages.length === 0) {
    findings.push({
      level: "error",
      code: "NO_MESSAGES",
      message: "NormalizedContext has zero messages",
    });
  }

  for (let i = 0; i < ctx.messages.length; i++) {
    const m = ctx.messages[i];
    if (!m) continue;
    if (!validRoles.has(m.role)) {
      findings.push({
        level: "warn",
        code: "UNKNOWN_ROLE",
        message: `message ${i + 1}: unknown role "${m.role}"`,
      });
    }
    if (!Array.isArray(m.content) || m.content.length === 0) {
      findings.push({
        level: "error",
        code: "EMPTY_MESSAGE",
        message: `message ${i + 1}: no content`,
      });
      continue;
    }
    for (let j = 0; j < m.content.length; j++) {
      const b = m.content[j];
      if (!b) continue;
      if (!validBlocks.has(b.type)) {
        findings.push({
          level: "warn",
          code: "UNKNOWN_BLOCK",
          message:
            `message ${i + 1}, block ${j + 1}: unknown type "${b.type}"`,
        });
      }
    }
  }

  const score = scoreFindings(findings);
  const status: DoctorResult["status"] = findings.some(
    (f) => f.level === "error",
  )
    ? "fail"
    : findings.some((f) => f.level === "warn")
      ? "warn"
      : "ok";

  const detectedFormat: FormatId =
    ctx.source.tool === "claude-code"
      ? "claude-code"
      : ctx.source.tool === "codex"
        ? "codex"
        : "unknown";

  return {
    filePath: "<NormalizedContext>",
    detectedFormat,
    status,
    score,
    lineCount: ctx.messages.length,
    parsedLineCount: ctx.messages.length,
    findings,
  };
}

export function formatDoctorResult(result: DoctorResult): string {
  const lines: string[] = [];
  lines.push(
    `Doctor ${result.detectedFormat}: ${result.status} (${result.score}/100)`,
  );
  lines.push(`File: ${result.filePath}`);
  if (result.expectedFormat) lines.push(`Expected: ${result.expectedFormat}`);
  lines.push(`Lines: ${result.parsedLineCount}/${result.lineCount} parsed`);
  lines.push("");
  if (result.findings.length === 0) {
    lines.push("No findings.");
  } else {
    lines.push("Findings:");
    for (const finding of result.findings) {
      const line = finding.line ? ` line ${finding.line}` : "";
      lines.push(
        `- [${finding.level}] ${finding.code}${line}: ${finding.message}`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

function normalizeFormat(value: string | undefined): FormatId | undefined {
  if (!value) return undefined;
  if (value === "codex-cli") return "codex";
  if (value === "codex" || value === "claude-code") return value;
  return "unknown";
}

async function resolveSessionPath(
  locator: string,
  format: FormatId | undefined,
): Promise<string> {
  if (looksLikePath(locator)) {
    return path.resolve(locator);
  }

  if (!format || format === "codex") {
    const codex = await findCodexRollout(locator);
    if (codex) return codex;
  }
  if (!format || format === "claude-code") {
    const claude = await findClaudeSession(locator);
    if (claude) return claude;
  }

  throw new Error(`Could not resolve session "${locator}"`);
}

function looksLikePath(locator: string): boolean {
  return (
    locator.endsWith(".jsonl") ||
    locator.includes("/") ||
    locator.includes("\\") ||
    path.isAbsolute(locator)
  );
}

async function findClaudeSession(id: string): Promise<string | null> {
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = path.join(CLAUDE_PROJECTS_DIR, dir, `${id}.jsonl`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

async function findCodexRollout(id: string): Promise<string | null> {
  let found: string | null = null;
  await walkRollouts(CODEX_SESSIONS_DIR, async (file, fullPath) => {
    if (!found && file.includes(id)) found = fullPath;
  });
  return found;
}

async function walkRollouts(
  root: string,
  visit: (file: string, fullPath: string) => Promise<void>,
): Promise<void> {
  let years: string[];
  try {
    years = await fs.readdir(root);
  } catch {
    return;
  }
  for (const year of years) {
    const yPath = path.join(root, year);
    let months: string[];
    try {
      months = await fs.readdir(yPath);
    } catch {
      continue;
    }
    for (const month of months) {
      const mPath = path.join(yPath, month);
      let days: string[];
      try {
        days = await fs.readdir(mPath);
      } catch {
        continue;
      }
      for (const day of days) {
        const dPath = path.join(mPath, day);
        let files: string[];
        try {
          files = await fs.readdir(dPath);
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) {
            continue;
          }
          await visit(file, path.join(dPath, file));
        }
      }
    }
  }
}

function detectFormat(lines: ParsedLine[]): FormatId {
  for (const { value } of lines) {
    if (value.type === "session_meta" && isRecord(value.payload)) {
      return "codex";
    }
  }
  for (const { value } of lines) {
    if (
      typeof value.sessionId === "string" ||
      typeof value.uuid === "string" ||
      Object.hasOwn(value, "parentUuid")
    ) {
      return "claude-code";
    }
  }
  return "unknown";
}

function validateClaude(lines: ParsedLine[], findings: DoctorFinding[]) {
  const uuids = new Set<string>();
  const parentRefs: Array<{ line: number; parentUuid: string }> = [];
  const children = new Map<string, number>();
  let messageLines = 0;

  for (const { line, value } of lines) {
    const type = value.type;
    if (typeof type !== "string") {
      findings.push({
        level: "error",
        code: "CLAUDE_TYPE_MISSING",
        message: "Claude line is missing string field `type`",
        line,
      });
      continue;
    }
    if (!CLAUDE_TYPES.has(type)) {
      findings.push({
        level: "warn",
        code: "CLAUDE_UNKNOWN_TYPE",
        message: `Unknown Claude wrapper type: ${type}`,
        line,
      });
    }

    const uuid = value.uuid;
    if (typeof uuid === "string") {
      if (uuids.has(uuid)) {
        findings.push({
          level: "error",
          code: "CLAUDE_DUPLICATE_UUID",
          message: `Duplicate uuid: ${uuid}`,
          line,
        });
      }
      uuids.add(uuid);
    } else if (type === "user" || type === "assistant") {
      findings.push({
        level: "error",
        code: "CLAUDE_UUID_MISSING",
        message: "Message-bearing Claude line is missing string `uuid`",
        line,
      });
    }

    if (typeof value.parentUuid === "string") {
      parentRefs.push({ line, parentUuid: value.parentUuid });
      if (typeof uuid === "string") {
        children.set(value.parentUuid, (children.get(value.parentUuid) ?? 0) + 1);
      }
    } else if (
      value.parentUuid !== null &&
      Object.hasOwn(value, "parentUuid")
    ) {
      findings.push({
        level: "warn",
        code: "CLAUDE_PARENT_UUID_SHAPE",
        message: "`parentUuid` should be string or null",
        line,
      });
    }

    if (type !== "user" && type !== "assistant") continue;
    messageLines++;
    if (typeof value.sessionId !== "string") {
      findings.push({
        level: "warn",
        code: "CLAUDE_SESSION_ID_MISSING",
        message: "Message line is missing string `sessionId`",
        line,
      });
    }
    if (typeof value.timestamp !== "string") {
      findings.push({
        level: "warn",
        code: "CLAUDE_TIMESTAMP_MISSING",
        message: "Message line is missing string `timestamp`",
        line,
      });
    }
    if (!isRecord(value.message)) {
      findings.push({
        level: "error",
        code: "CLAUDE_MESSAGE_MISSING",
        message: "Message line is missing object `message`",
        line,
      });
      continue;
    }
    const msg = value.message;
    if (msg.role !== "user" && msg.role !== "assistant") {
      findings.push({
        level: "warn",
        code: "CLAUDE_MESSAGE_ROLE",
        message: "`message.role` should be user or assistant",
        line,
      });
    }
    validateClaudeContent(msg.content, line, findings);
  }

  if (messageLines === 0) {
    findings.push({
      level: "error",
      code: "CLAUDE_NO_MESSAGES",
      message: "No user/assistant message lines found",
    });
  }
  for (const ref of parentRefs) {
    if (!uuids.has(ref.parentUuid)) {
      findings.push({
        level: "warn",
        code: "CLAUDE_PARENT_MISSING",
        message: `parentUuid does not point at a line in this file: ${ref.parentUuid}`,
        line: ref.line,
      });
    }
  }
  const branchParents = [...children.entries()].filter(([, count]) => count > 1);
  if (branchParents.length > 0) {
    findings.push({
      level: "info",
      code: "CLAUDE_BRANCHES",
      message: `${branchParents.length} parent node(s) have multiple children; extractor will pick the latest-leaf chain`,
    });
  }
}

function validateClaudeContent(
  content: unknown,
  line: number,
  findings: DoctorFinding[],
) {
  if (typeof content === "string") return;
  if (!Array.isArray(content)) {
    findings.push({
      level: "error",
      code: "CLAUDE_CONTENT_SHAPE",
      message: "`message.content` should be a string or block array",
      line,
    });
    return;
  }
  for (const block of content) {
    if (!isRecord(block)) {
      findings.push({
        level: "warn",
        code: "CLAUDE_BLOCK_SHAPE",
        message: "Content block should be an object",
        line,
      });
      continue;
    }
    const type = block.type;
    if (type === "text") {
      if (typeof block.text !== "string") {
        findings.push({
          level: "error",
          code: "CLAUDE_TEXT_BLOCK",
          message: "text block is missing string `text`",
          line,
        });
      }
    } else if (type === "thinking") {
      if (typeof block.thinking !== "string") {
        findings.push({
          level: "warn",
          code: "CLAUDE_THINKING_BLOCK",
          message: "thinking block is missing string `thinking`",
          line,
        });
      }
    } else if (type === "tool_use") {
      if (typeof block.name !== "string") {
        findings.push({
          level: "error",
          code: "CLAUDE_TOOL_USE_NAME",
          message: "tool_use block is missing string `name`",
          line,
        });
      }
      if (typeof block.id !== "string") {
        findings.push({
          level: "warn",
          code: "CLAUDE_TOOL_USE_ID",
          message: "tool_use block is missing string `id`",
          line,
        });
      }
      if (!Object.hasOwn(block, "input")) {
        findings.push({
          level: "warn",
          code: "CLAUDE_TOOL_USE_INPUT",
          message: "tool_use block is missing `input`",
          line,
        });
      }
    } else if (type === "tool_result") {
      if (!Object.hasOwn(block, "content")) {
        findings.push({
          level: "error",
          code: "CLAUDE_TOOL_RESULT_CONTENT",
          message: "tool_result block is missing `content`",
          line,
        });
      }
      if (typeof block.tool_use_id !== "string") {
        findings.push({
          level: "warn",
          code: "CLAUDE_TOOL_RESULT_ID",
          message: "tool_result block is missing string `tool_use_id`",
          line,
        });
      }
    } else {
      findings.push({
        level: "warn",
        code: "CLAUDE_UNKNOWN_BLOCK",
        message: `Unknown Claude content block type: ${String(type)}`,
        line,
      });
    }
  }
}

function validateCodex(lines: ParsedLine[], findings: DoctorFinding[]) {
  let sessionMetaCount = 0;
  let responseItemCount = 0;
  const functionCallIds = new Set<string>();
  const outputRefs: Array<{ line: number; callId: string }> = [];

  const first = lines[0];
  if (first && first.value.type !== "session_meta") {
    findings.push({
      level: "error",
      code: "CODEX_FIRST_LINE",
      message: "First Codex JSONL object should be `session_meta`",
      line: first.line,
    });
  }

  for (const { line, value } of lines) {
    const type = value.type;
    if (typeof type !== "string") {
      findings.push({
        level: "error",
        code: "CODEX_TYPE_MISSING",
        message: "Codex line is missing string field `type`",
        line,
      });
      continue;
    }
    if (!CODEX_WRAPPER_TYPES.has(type)) {
      findings.push({
        level: "warn",
        code: "CODEX_UNKNOWN_WRAPPER",
        message: `Unknown Codex wrapper type: ${type}`,
        line,
      });
    }
    if (!isRecord(value.payload)) {
      findings.push({
        level: "error",
        code: "CODEX_PAYLOAD_MISSING",
        message: "Codex wrapper is missing object `payload`",
        line,
      });
      continue;
    }

    if (type === "session_meta") {
      sessionMetaCount++;
      validateCodexSessionMeta(value.payload, line, findings);
    } else if (type === "response_item") {
      responseItemCount++;
      validateCodexResponseItem(
        value.payload,
        line,
        findings,
        functionCallIds,
        outputRefs,
      );
    } else if (type === "event_msg") {
      validateCodexEvent(value.payload, line, findings);
    }
  }

  if (sessionMetaCount === 0) {
    findings.push({
      level: "error",
      code: "CODEX_SESSION_META_MISSING",
      message: "No `session_meta` line found",
    });
  }
  if (sessionMetaCount > 1) {
    findings.push({
      level: "warn",
      code: "CODEX_SESSION_META_DUPLICATE",
      message: `Found ${sessionMetaCount} session_meta lines`,
    });
  }
  if (responseItemCount === 0) {
    findings.push({
      level: "error",
      code: "CODEX_NO_RESPONSE_ITEMS",
      message: "No `response_item` lines found",
    });
  }
  for (const ref of outputRefs) {
    if (!functionCallIds.has(ref.callId)) {
      findings.push({
        level: "warn",
        code: "CODEX_OUTPUT_WITHOUT_CALL",
        message: `function_call_output references unknown call_id: ${ref.callId}`,
        line: ref.line,
      });
    }
  }
}

function validateCodexSessionMeta(
  payload: Record<string, unknown>,
  line: number,
  findings: DoctorFinding[],
) {
  if (typeof payload.id !== "string") {
    findings.push({
      level: "error",
      code: "CODEX_SESSION_ID",
      message: "session_meta.payload is missing string `id`",
      line,
    });
  }
  if (typeof payload.cwd !== "string") {
    findings.push({
      level: "warn",
      code: "CODEX_CWD",
      message: "session_meta.payload is missing string `cwd`",
      line,
    });
  }
  if (payload.model_provider !== "openai") {
    findings.push({
      level: "warn",
      code: "CODEX_MODEL_PROVIDER",
      message: "session_meta.payload.model_provider is not `openai`",
      line,
    });
  }
  const baseInstructions = payload.base_instructions;
  if (
    baseInstructions !== undefined &&
    (!isRecord(baseInstructions) ||
      typeof baseInstructions.text !== "string")
  ) {
    findings.push({
      level: "warn",
      code: "CODEX_BASE_INSTRUCTIONS",
      message: "base_instructions should be an object with string `text`",
      line,
    });
  }
}

function validateCodexResponseItem(
  payload: Record<string, unknown>,
  line: number,
  findings: DoctorFinding[],
  functionCallIds: Set<string>,
  outputRefs: Array<{ line: number; callId: string }>,
) {
  const itemType = payload.type;
  if (typeof itemType !== "string") {
    findings.push({
      level: "error",
      code: "CODEX_RESPONSE_ITEM_TYPE",
      message: "response_item.payload is missing string `type`",
      line,
    });
    return;
  }
  if (!CODEX_RESPONSE_ITEM_TYPES.has(itemType)) {
    findings.push({
      level: "warn",
      code: "CODEX_UNKNOWN_RESPONSE_ITEM",
      message: `Unknown response_item payload type: ${itemType}`,
      line,
    });
    return;
  }

  if (itemType === "message") {
    validateCodexMessageItem(payload, line, findings);
  } else if (itemType === "function_call") {
    if (typeof payload.name !== "string") {
      findings.push({
        level: "error",
        code: "CODEX_FUNCTION_NAME",
        message: "function_call is missing string `name`",
        line,
      });
    }
    if (typeof payload.call_id === "string") {
      functionCallIds.add(payload.call_id);
    } else {
      findings.push({
        level: "error",
        code: "CODEX_FUNCTION_CALL_ID",
        message: "function_call is missing string `call_id`",
        line,
      });
    }
    if (typeof payload.arguments !== "string") {
      findings.push({
        level: "warn",
        code: "CODEX_FUNCTION_ARGUMENTS",
        message: "function_call.arguments should be a JSON-encoded string",
        line,
      });
    } else {
      try {
        JSON.parse(payload.arguments);
      } catch {
        findings.push({
          level: "warn",
          code: "CODEX_FUNCTION_ARGUMENTS_JSON",
          message: "function_call.arguments is not valid JSON text",
          line,
        });
      }
    }
  } else if (itemType === "function_call_output") {
    if (typeof payload.call_id === "string") {
      outputRefs.push({ line, callId: payload.call_id });
    } else {
      findings.push({
        level: "error",
        code: "CODEX_OUTPUT_CALL_ID",
        message: "function_call_output is missing string `call_id`",
        line,
      });
    }
    if (typeof payload.output !== "string") {
      findings.push({
        level: "error",
        code: "CODEX_OUTPUT_TEXT",
        message: "function_call_output is missing string `output`",
        line,
      });
    }
  } else if (itemType === "reasoning" || itemType === "web_search_call") {
    // Current Codex rollouts may include reasoning and web-search response
    // items. The adapters intentionally drop these when normalizing context,
    // so their presence is compatible with conversion.
    return;
  }
}

function validateCodexMessageItem(
  payload: Record<string, unknown>,
  line: number,
  findings: DoctorFinding[],
) {
  const role = payload.role;
  if (
    role !== "user" &&
    role !== "assistant" &&
    role !== "developer" &&
    role !== "system"
  ) {
    findings.push({
      level: "error",
      code: "CODEX_MESSAGE_ROLE",
      message: "message role should be user, assistant, developer, or system",
      line,
    });
  }
  if (!Array.isArray(payload.content)) {
    findings.push({
      level: "error",
      code: "CODEX_MESSAGE_CONTENT",
      message: "message content should be an array",
      line,
    });
    return;
  }
  for (const block of payload.content) {
    if (!isRecord(block)) {
      findings.push({
        level: "warn",
        code: "CODEX_MESSAGE_BLOCK_SHAPE",
        message: "message content block should be an object",
        line,
      });
      continue;
    }
    if (block.type !== "input_text" && block.type !== "output_text") {
      findings.push({
        level: "warn",
        code: "CODEX_MESSAGE_BLOCK_TYPE",
        message: `unknown message content block type: ${String(block.type)}`,
        line,
      });
    }
    if (typeof block.text !== "string") {
      findings.push({
        level: "error",
        code: "CODEX_MESSAGE_BLOCK_TEXT",
        message: "message content block is missing string `text`",
        line,
      });
    }
  }
}

function validateCodexEvent(
  payload: Record<string, unknown>,
  line: number,
  findings: DoctorFinding[],
) {
  if (typeof payload.type !== "string") {
    findings.push({
      level: "warn",
      code: "CODEX_EVENT_TYPE",
      message: "event_msg payload is missing string `type`",
      line,
    });
  }
}

function scoreFindings(findings: DoctorFinding[]): number {
  const penalty = findings.reduce((total, finding) => {
    if (finding.level === "error") return total + 25;
    if (finding.level === "warn") return total + 8;
    return total;
  }, 0);
  return Math.max(0, 100 - penalty);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
