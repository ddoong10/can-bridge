import type { SourceAdapter, TargetAdapter, InjectionResult, SessionSummary } from "./base.js";
import type { NormalizedContext } from "../schema/context.js";
export declare class CodexAdapter implements SourceAdapter, TargetAdapter {
    readonly id = "codex";
    extract(locator: string): Promise<NormalizedContext>;
    listSessions(): Promise<SessionSummary[]>;
    private resolveSessionPath;
    inject(context: NormalizedContext): Promise<InjectionResult>;
}
