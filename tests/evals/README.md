# Eval Fixtures

Eval cases are JSON files consumed by:

```powershell
can-bridge eval run --case <case.json> --agent <codex|claude-code>
can-bridge eval score --case <case.json> --run <run-dir>
```

`eval run` is the fully automatic path. It runs the agent, captures the
transcript, records commands, saves the post-run diff, and scores the result.

Use `--source <codex|claude-code> --source-session <id|latest>` with
`--condition converted` to test an actual can-bridge conversion before the
target agent runs.

