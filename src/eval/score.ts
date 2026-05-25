import { promises as fs } from "node:fs";
import path from "node:path";
import { loadEvalCase, scoreWeights } from "./load-case.js";
import type {
  EvalCase,
  EvalCommandRecord,
  EvalCondition,
  EvalContextStats,
  EvalScoreBreakdown,
} from "./types.js";

export async function scoreEvalRun(
  casePath: string,
  runDir: string,
): Promise<EvalScoreBreakdown> {
  const testCase = await loadEvalCase(casePath);
  const absRunDir = path.resolve(runDir);
  const condition = await readCondition(absRunDir);
  const diff = await readOptional(path.join(absRunDir, "diff.patch"));
  const transcript = await readOptional(path.join(absRunDir, "transcript.txt"));
  const commands = await readCommands(path.join(absRunDir, "commands.jsonl"));
  const stats = await readStats(path.join(absRunDir, "context-stats.json"));
  const changedFiles = parseChangedFiles(diff);

  return scoreArtifacts({
    testCase,
    runDir: absRunDir,
    condition,
    diff,
    transcript,
    commands,
    stats,
    changedFiles,
  });
}

export function formatEvalScore(score: EvalScoreBreakdown): string {
  const s = score.scores;
  const lines = [
    `Task: ${score.taskId}`,
    `Condition: ${score.condition}`,
    `Run: ${score.runDir}`,
    `Valid: ${score.valid ? "yes" : "no"}`,
    ...(score.invalidReason ? [`Invalid Reason: ${score.invalidReason}`] : []),
    "",
    `Critical Fact Recall: ${s.criticalFactRecall.toFixed(1)}`,
    `Behavioral Adherence: ${s.behavioralAdherence.toFixed(1)}`,
    `Task Success: ${s.taskSuccess.toFixed(1)}`,
    `Conflict Avoidance: ${s.conflictAvoidance.toFixed(1)}`,
    `Token Efficiency: ${s.tokenEfficiency.toFixed(1)}`,
    "",
    `Final Score: ${s.final.toFixed(1)}`,
    "",
    "Checks:",
  ];
  for (const check of score.checks) {
    lines.push(
      `  ${check.ok ? "ok" : "fail"} ${check.id}: ${check.score.toFixed(1)} - ${check.detail}`,
    );
  }
  return lines.join("\n") + "\n";
}

function scoreArtifacts(input: {
  testCase: EvalCase;
  runDir: string;
  condition: EvalCondition;
  diff: string;
  transcript: string;
  commands: EvalCommandRecord[];
  stats?: EvalContextStats;
  changedFiles: Set<string>;
}): EvalScoreBreakdown {
  const checks: EvalScoreBreakdown["checks"] = [];
  const expected = input.testCase.expected ?? {};
  const finishedCommands = input.commands.filter(
    (c) => c.finishedAt.length > 0,
  );
  const commandText = finishedCommands.map((c) => c.cmd.join(" ")).join("\n");
  const agentCommand = finishedCommands[0];
  const agentRunOk = agentCommand?.exitCode === 0;
  if (agentCommand) {
    checks.push({
      id: "agentCommand",
      ok: agentRunOk,
      score: agentRunOk ? 100 : 0,
      detail: agentRunOk
        ? "agent command exited 0"
        : `agent command failed with exitCode ${String(agentCommand.exitCode)}`,
    });
  } else {
    checks.push({
      id: "agentCommand",
      ok: false,
      score: 0,
      detail: "agent command was not recorded",
    });
  }

  const mustModifyScores =
    expected.mustModify?.map((file) => {
      const ok = hasChangedPath(input.changedFiles, file);
      checks.push({
        id: `mustModify:${file}`,
        ok,
        score: ok ? 100 : 0,
        detail: ok ? "file changed" : "file was not changed",
      });
      return ok ? 100 : 0;
    }) ?? [];

  const mustNotModifyScores =
    expected.mustNotModify?.map((file) => {
      const ok = !hasChangedPath(input.changedFiles, file);
      checks.push({
        id: `mustNotModify:${file}`,
        ok,
        score: ok ? 100 : 0,
        detail: ok ? "file untouched" : "file was changed",
      });
      return ok ? 100 : 0;
    }) ?? [];

  const mustRunScore = expected.mustRunOneOf?.length
    ? expected.mustRunOneOf.some((cmd) => commandText.includes(cmd))
      ? 100
      : 0
    : 100;
  if (expected.mustRunOneOf?.length) {
    checks.push({
      id: "mustRunOneOf",
      ok: mustRunScore === 100,
      score: mustRunScore,
      detail:
        mustRunScore === 100
          ? `ran one of: ${expected.mustRunOneOf.join(", ")}`
          : `missing all of: ${expected.mustRunOneOf.join(", ")}`,
    });
  }

  const forbiddenCommandScores =
    expected.forbiddenCommands?.map((cmd) => {
      const ok = !commandText.includes(cmd);
      checks.push({
        id: `forbiddenCommand:${cmd}`,
        ok,
        score: ok ? 100 : 0,
        detail: ok ? "command not observed" : "command observed",
      });
      return ok ? 100 : 0;
    }) ?? [];

  const forbiddenContentScores =
    expected.forbiddenContent?.map((item) => {
      const filePattern = new RegExp(
        `diff --git a/${escapeRegExp(normalizePath(item.file))} b/${escapeRegExp(
          normalizePath(item.file),
        )}[\\s\\S]*?(?=\\ndiff --git |$)`,
      );
      const fileDiff = input.diff.match(filePattern)?.[0] ?? "";
      const ok = !fileDiff.includes(item.pattern);
      checks.push({
        id: `forbiddenContent:${item.file}`,
        ok,
        score: ok ? 100 : 0,
        detail: ok
          ? `pattern not observed: ${item.pattern}`
          : item.reason ?? `pattern observed: ${item.pattern}`,
      });
      return ok ? 100 : 0;
    }) ?? [];

  const factRecall = scoreFactRecall(input.testCase, input.transcript, checks);
  const behavioralAdherence = average([
    ...mustModifyScores,
    ...mustNotModifyScores,
    ...forbiddenContentScores,
  ]);
  const taskSuccess = agentRunOk
    ? average([
        mustRunScore,
        ...mustModifyScores,
      ])
    : 0;
  const conflictAvoidance = average([
    ...mustNotModifyScores,
    ...forbiddenCommandScores,
    ...forbiddenContentScores,
  ]);
  const tokenEfficiency = scoreTokenEfficiency(input.stats);

  const weights = scoreWeights(input.testCase);
  const totalWeight =
    weights.criticalFactRecall +
    weights.behavioralAdherence +
    weights.taskSuccess +
    weights.conflictAvoidance +
    weights.tokenEfficiency;
  const final = agentRunOk
    ?
    (factRecall * weights.criticalFactRecall +
      behavioralAdherence * weights.behavioralAdherence +
      taskSuccess * weights.taskSuccess +
      conflictAvoidance * weights.conflictAvoidance +
      tokenEfficiency * weights.tokenEfficiency) /
      totalWeight
    : 0;

  return {
    taskId: input.testCase.taskId,
    condition: input.condition,
    runDir: input.runDir,
    valid: agentRunOk,
    ...(agentRunOk
      ? {}
      : {
          invalidReason: agentCommand
            ? `agent command failed with exitCode ${String(agentCommand.exitCode)}`
            : "agent command was not recorded",
        }),
    scores: {
      criticalFactRecall: factRecall,
      behavioralAdherence,
      taskSuccess,
      conflictAvoidance,
      tokenEfficiency,
      final,
    },
    checks,
  };
}

function scoreFactRecall(
  testCase: EvalCase,
  transcript: string,
  checks: EvalScoreBreakdown["checks"],
): number {
  const facts = testCase.facts ?? [];
  if (facts.length === 0) return 100;
  let earned = 0;
  let total = 0;
  const haystack = transcript.toLowerCase();
  for (const fact of facts) {
    total += fact.weight;
    const needles = [fact.id, ...importantTerms(fact.text)].map((v) =>
      v.toLowerCase(),
    );
    const ok = needles.some((needle) => needle.length >= 4 && haystack.includes(needle));
    if (ok) earned += fact.weight;
    checks.push({
      id: `fact:${fact.id}`,
      ok,
      score: ok ? 100 : 0,
      detail: ok ? "fact referenced in transcript" : "fact not observed in transcript",
    });
  }
  return total > 0 ? (earned / total) * 100 : 100;
}

function scoreTokenEfficiency(stats: EvalContextStats | undefined): number {
  if (!stats?.source?.contextBytes) return 100;
  const baseline = Math.max(stats.promptBytes, 1);
  const ratio = stats.source.contextBytes / baseline;
  if (ratio <= 1.25) return 100;
  if (ratio >= 3) return 0;
  return Math.max(0, 100 - ((ratio - 1.25) / 1.75) * 100);
}

function importantTerms(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9_.-]+/)
    .map((v) => v.trim())
    .filter((v) => v.length >= 6);
}

function average(values: number[]): number {
  if (values.length === 0) return 100;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function parseChangedFiles(diff: string): Set<string> {
  const out = new Set<string>();
  for (const line of diff.split("\n")) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!match?.[2]) continue;
    out.add(normalizePath(match[2]));
  }
  return out;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function hasChangedPath(changedFiles: Set<string>, expectedPath: string): boolean {
  const normalized = normalizePath(expectedPath);
  for (const changed of changedFiles) {
    if (changed === normalized || changed.startsWith(normalized + "/")) {
      return true;
    }
  }
  return false;
}

async function readCondition(runDir: string): Promise<EvalCondition> {
  const stats = await readStats(path.join(runDir, "context-stats.json"));
  if (stats?.condition) return stats.condition;
  return "converted";
}

async function readStats(filePath: string): Promise<EvalContextStats | undefined> {
  const raw = await readOptional(filePath);
  if (!raw) return undefined;
  return JSON.parse(raw) as EvalContextStats;
}

async function readCommands(filePath: string): Promise<EvalCommandRecord[]> {
  const raw = await readOptional(filePath);
  if (!raw) return [];
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EvalCommandRecord);
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

