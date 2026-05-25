import { promises as fs } from "node:fs";
import path from "node:path";
export const DEFAULT_SCORE_WEIGHTS = {
    criticalFactRecall: 25,
    behavioralAdherence: 30,
    taskSuccess: 25,
    conflictAvoidance: 10,
    // Token efficiency is reported as a diagnostic by default, but it should not
    // dominate Original/Converted/No Context behavior comparisons. Individual
    // cases can opt it into the final score when comparing compression strategies.
    tokenEfficiency: 0,
};
export async function loadEvalCase(filePath) {
    const abs = path.resolve(filePath);
    const raw = await fs.readFile(abs, "utf8");
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw new Error(`Invalid eval case JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return validateEvalCase(parsed, abs);
}
export function scoreWeights(testCase) {
    return {
        ...DEFAULT_SCORE_WEIGHTS,
        ...(testCase.score ?? {}),
    };
}
function validateEvalCase(value, filePath) {
    if (!value || typeof value !== "object") {
        throw new Error(`Invalid eval case ${filePath}: expected object`);
    }
    const obj = value;
    const taskId = readString(obj, "taskId", filePath);
    const taskType = readString(obj, "taskType", filePath);
    if (taskType !== "recall" &&
        taskType !== "rule_following" &&
        taskType !== "gotcha" &&
        taskType !== "continuation") {
        throw new Error(`Invalid eval case ${filePath}: unsupported taskType ${taskType}`);
    }
    const prompt = readString(obj, "prompt", filePath);
    return {
        taskId,
        taskType,
        prompt,
        facts: Array.isArray(obj.facts)
            ? obj.facts.map((fact, i) => validateFact(fact, filePath, i))
            : undefined,
        expected: obj.expected && typeof obj.expected === "object"
            ? validateExpected(obj.expected, filePath)
            : undefined,
        score: obj.score && typeof obj.score === "object"
            ? validateScore(obj.score, filePath)
            : undefined,
    };
}
function validateFact(value, filePath, index) {
    if (!value || typeof value !== "object") {
        throw new Error(`Invalid eval case ${filePath}: facts[${index}] must be object`);
    }
    const obj = value;
    const id = readString(obj, "id", filePath);
    const text = readString(obj, "text", filePath);
    const weight = Number(obj.weight);
    if (!Number.isFinite(weight) || weight <= 0) {
        throw new Error(`Invalid eval case ${filePath}: facts[${index}].weight must be positive`);
    }
    return { id, text, weight };
}
function validateExpected(obj, filePath) {
    return {
        mustModify: readStringArray(obj.mustModify, "expected.mustModify", filePath),
        mustNotModify: readStringArray(obj.mustNotModify, "expected.mustNotModify", filePath),
        mustRunOneOf: readStringArray(obj.mustRunOneOf, "expected.mustRunOneOf", filePath),
        forbiddenCommands: readStringArray(obj.forbiddenCommands, "expected.forbiddenCommands", filePath),
        forbiddenContent: Array.isArray(obj.forbiddenContent)
            ? obj.forbiddenContent.map((item, i) => {
                if (!item || typeof item !== "object") {
                    throw new Error(`Invalid eval case ${filePath}: expected.forbiddenContent[${i}] must be object`);
                }
                const content = item;
                return {
                    file: readString(content, "file", filePath),
                    pattern: readString(content, "pattern", filePath),
                    reason: typeof content.reason === "string" ? content.reason : undefined,
                };
            })
            : undefined,
    };
}
function validateScore(obj, filePath) {
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) {
            throw new Error(`Invalid eval case ${filePath}: score.${key} must be non-negative`);
        }
        out[key] = n;
    }
    return out;
}
function readString(obj, key, filePath) {
    const value = obj[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Invalid eval case ${filePath}: ${key} must be a non-empty string`);
    }
    return value;
}
function readStringArray(value, key, filePath) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        throw new Error(`Invalid eval case ${filePath}: ${key} must be a string array`);
    }
    return value;
}
//# sourceMappingURL=load-case.js.map