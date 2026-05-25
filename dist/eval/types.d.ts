export type EvalCondition = "original" | "converted" | "no-context" | "human-target";
export type EvalAgent = "codex" | "claude-code";
export interface EvalFact {
    id: string;
    text: string;
    weight: number;
}
export interface EvalExpected {
    mustModify?: string[];
    mustNotModify?: string[];
    mustRunOneOf?: string[];
    forbiddenCommands?: string[];
    forbiddenContent?: Array<{
        file: string;
        pattern: string;
        reason?: string;
    }>;
}
export interface EvalScoreWeights {
    criticalFactRecall: number;
    behavioralAdherence: number;
    taskSuccess: number;
    conflictAvoidance: number;
    tokenEfficiency: number;
}
export interface EvalCase {
    taskId: string;
    taskType: "recall" | "rule_following" | "gotcha" | "continuation";
    prompt: string;
    facts?: EvalFact[];
    expected?: EvalExpected;
    score?: Partial<EvalScoreWeights>;
}
export interface EvalCommandRecord {
    cmd: string[];
    cwd: string;
    startedAt: string;
    finishedAt: string;
    exitCode: number | null;
    stdoutFile?: string;
    stderrFile?: string;
}
export interface EvalContextStats {
    condition: EvalCondition;
    agent: EvalAgent;
    promptBytes: number;
    source?: {
        adapter: string;
        session: string;
        messageCount?: number;
        contextBytes?: number;
    };
    injected?: {
        target: string;
        sessionId?: string;
        locator: string;
    };
}
export interface EvalScoreBreakdown {
    taskId: string;
    condition: EvalCondition;
    runDir: string;
    valid: boolean;
    invalidReason?: string;
    scores: {
        criticalFactRecall: number;
        behavioralAdherence: number;
        taskSuccess: number;
        conflictAvoidance: number;
        tokenEfficiency: number;
        final: number;
    };
    checks: Array<{
        id: string;
        ok: boolean;
        score: number;
        detail: string;
    }>;
}
