import type { EvalCase, EvalScoreWeights } from "./types.js";
export declare const DEFAULT_SCORE_WEIGHTS: EvalScoreWeights;
export declare function loadEvalCase(filePath: string): Promise<EvalCase>;
export declare function scoreWeights(testCase: EvalCase): EvalScoreWeights;
