import type { EvalAgent, EvalCondition } from "./types.js";
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
export declare function runEvalCase(opts: EvalRunOptions): Promise<{
    runDir: string;
    scorePath?: string;
}>;
