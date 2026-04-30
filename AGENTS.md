# Codex Instructions

## Project Purpose

This repository builds `llm-context-harness`, a TypeScript CLI for moving coding
agent context between tools. The current v0 path is Claude Code session JSONL to
Codex prompt or rollout JSONL.

## Required Context

Before changing files, read:

- `TASK_CONTEXT.md`
- `docs/HANDOFF.md`
- `docs/DECISIONS.md`
- `CLAUDE.md` when changes affect Claude Code behavior or shared workflow

## Collaboration Protocol

- Treat `TASK_CONTEXT.md` as the current shared task state.
- Add a top entry to `docs/HANDOFF.md` before handing work to another agent.
- Add durable choices to `docs/DECISIONS.md`; do not bury them in chat only.
- Do not rely on hidden Claude or Codex context. If another agent needs to know
  it, write it into the shared files.
- Avoid concurrent edits to the same file across agents. If that happens, read
  the current file and preserve the other agent's work.

## Engineering Rules

- Keep adapters small and format-specific.
- Keep schema and transform logic free of filesystem I/O.
- Prefer explicit parsing over ad hoc string manipulation.
- Fail loudly when source or target session formats do not match expectations.
- Do not manually modify `~/.codex` or `~/.claude` state files except when the
  user asks for adapter research or debugging.

## Verification

Run the narrowest useful check after changes:

```powershell
npm run build
npm test
```

If a check cannot run, record the reason in the final response and in
`docs/HANDOFF.md` when handing off.
