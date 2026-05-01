/**
 * NormalizedContext — the common format that all adapters convert to and from.
 *
 * Design principle: keep the schema *minimal but lossless*. We'd rather carry
 * an opaque `metadata` blob per message than invent fields we'll regret later.
 * If a target adapter needs source-specific info, it can read from `metadata`.
 */
export type Role = "system" | "user" | "assistant" | "tool";
export interface NormalizedMessage {
    role: Role;
    content: ContentBlock[];
    /** ISO 8601. Optional because some sources don't record it. */
    timestamp?: string;
    /** Free-form per-message metadata from the source adapter. */
    metadata?: Record<string, unknown>;
}
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;
export interface TextBlock {
    type: "text";
    text: string;
}
export interface ThinkingBlock {
    type: "thinking";
    text: string;
}
export interface ToolUseBlock {
    type: "tool_use";
    /** Source-specific tool call id, if any. */
    id?: string;
    name: string;
    input: unknown;
}
export interface ToolResultBlock {
    type: "tool_result";
    /** Refers back to ToolUseBlock.id when available. */
    toolUseId?: string;
    /** Stringified output. We don't try to parse tool outputs. */
    output: string;
    isError?: boolean;
}
export interface NormalizedContext {
    schemaVersion: "0.1";
    source: SourceInfo;
    summary?: string;
    messages: NormalizedMessage[];
    metadata?: Record<string, unknown>;
}
export interface SourceInfo {
    /** e.g. "claude-code", "codex-cli". */
    tool: string;
    /** e.g. the model used in the original conversation, if known. */
    model?: string;
    sessionId?: string;
    capturedAt?: string;
    /** Working directory of the original session, if known. */
    cwd?: string;
}
