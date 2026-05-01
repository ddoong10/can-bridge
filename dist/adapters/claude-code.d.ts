import type { SourceAdapter, TargetAdapter, InjectionResult, SessionSummary } from "./base.js";
import type { NormalizedContext } from "../schema/context.js";
export declare class ClaudeCodeAdapter implements SourceAdapter, TargetAdapter {
    readonly id = "claude-code";
    extract(locator: string): Promise<NormalizedContext>;
    listSessions(): Promise<SessionSummary[]>;
    private resolveSessionPath;
    inject(context: NormalizedContext): Promise<InjectionResult>;
}
