# Evaluation

can-bridge evaluates context preservation by behavior, not text similarity
alone. A converted context is useful only if the target coding agent behaves as
if it had the original context.

## Automatic Pipeline

The automatic MVP is:

```text
eval case JSON
  -> can-bridge eval run
  -> optional source session extraction and target injection
  -> target agent runs non-interactively
  -> diff.patch, commands.jsonl, transcript.txt, context-stats.json
  -> deterministic score
```

For converted-context runs:

```powershell
can-bridge eval run `
  --case tests/evals/fixtures/can-bridge-redactor-rule-following.json `
  --condition converted `
  --source codex `
  --source-session latest `
  --agent claude-code
```

That command extracts the source session, injects it into the target agent,
runs the target agent with the case prompt, records artifacts under `runs/`,
and writes `score.json`.

For no-context or original-context baselines:

```powershell
can-bridge eval run `
  --case tests/evals/fixtures/can-bridge-redactor-rule-following.json `
  --condition no-context `
  --agent codex
```

## Scoring

The default behavior score is:

```text
Context Retention Score =
0.25 * Critical Fact Recall
+ 0.30 * Behavioral Adherence
+ 0.25 * Task Success
+ 0.10 * Conflict Avoidance
```

Token efficiency is still reported, but it is not included in the default final
score. Otherwise Converted can look worse than No Context simply because it
received more context, even when behavior is identical. A case can explicitly
set `score.tokenEfficiency` when the experiment is about compression or context
budgeting.

The deterministic scorer checks:

- changed files from `git diff --binary`
- required files that must be modified
- files that must not be modified
- required command patterns
- forbidden command patterns
- forbidden diff content
- context byte size
- fact mentions in the transcript

Semantic judgment can be added later, but the default path must work without an
LLM judge.

