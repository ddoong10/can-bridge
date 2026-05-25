import type { EvalScoreBreakdown } from "./types.js";
export declare function scoreEvalRun(casePath: string, runDir: string): Promise<EvalScoreBreakdown>;
export declare function formatEvalScore(score: EvalScoreBreakdown): string;
