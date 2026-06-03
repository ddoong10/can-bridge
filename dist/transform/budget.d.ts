import type { NormalizedContext } from "../schema/context.js";
export interface ContextBudgetOptions {
    /** Keep only messages after the latest Codex `compacted` line when present. */
    sinceCompact?: boolean;
    /** Truncate large tool_result outputs in normalized messages. */
    maxToolOutputChars?: number;
    /** Keep `raw` for same-tool native replay. Defaults to true. */
    includeNative?: boolean;
}
export interface ContextBudgetStats {
    sinceCompact: boolean;
    compactedAt?: string;
    droppedMessages: number;
    droppedRawLines: number;
    truncatedToolOutputs: number;
    omittedToolOutputChars: number;
    nativeIncluded: boolean;
}
export interface ContextBudgetResult {
    context: NormalizedContext;
    stats: ContextBudgetStats;
}
export declare function applyContextBudget(ctx: NormalizedContext, opts?: ContextBudgetOptions): ContextBudgetResult;
