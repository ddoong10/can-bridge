# LLM Context Harness

## What this project is

A tool for extracting conversation context from one LLM tool/platform, transforming it into a normalized format, and injecting it into another LLM tool/platform — so a user can continue the same conversation across different models, or hand off a conversation to someone else.

Three-stage pipeline:
1. **Extract** — read conversation history from the source tool (e.g., parse a Claude Code session JSONL).
2. **Transform** — normalize into our common schema (`NormalizedContext`), then re-format for the target.
3. **Inject** — write the converted context into the target tool's expected location/format.

## Current scope (v0)

- **Source:** Claude Code session files (`~/.claude/projects/<project-hash>/<session-id>.jsonl`)
- **Target:** Codex CLI session files (`~/.codex/sessions/<date>/rollout-*.jsonl`)
- **Form factor:** CLI

Other sources/targets (Cursor, ChatGPT web export, Gemini, Claude API direct, etc.) are explicitly out of scope until v0 works end-to-end.

## Reality check — what we don't know yet

The exact on-disk formats of both Claude Code and Codex CLI session files are **not officially documented and may change between versions**. The first task in any new session is to verify the current format on the user's machine before writing or modifying parser code. Do not assume schemas from memory — always inspect a real file first.

If a format has changed and breaks the adapter, that is expected, not a bug to hide. Surface the mismatch clearly.

## Architecture

```
Source tool (Claude Code)
        │
        ▼
┌─────────────────┐
│ SourceAdapter   │  extract() → NormalizedContext
│ .extract()      │
└─────────────────┘
        │
        ▼
   NormalizedContext  (src/schema/context.ts)
        │
        ▼
┌─────────────────┐
│ TargetAdapter   │  inject(ctx) → writes target session file
│ .inject()       │
└─────────────────┘
        │
        ▼
Target tool (Codex CLI) — user runs `codex resume <id>`
```

All adapters implement the same interface (`src/adapters/base.ts`). Adding a new tool = writing one new adapter file. No core logic changes.

## Coding conventions

- **TypeScript, strict mode.** No `any` unless interfacing with raw external JSON, and even then narrow it at the boundary.
- **Pure functions where possible.** The transform layer especially should be pure: `(input) => output`, no I/O.
- **I/O at the edges.** File reads/writes live in adapters. Schema and transform code never touches the filesystem.
- **Fail loudly on unknown formats.** If a JSONL line has a `type` we don't recognize, log it and either skip with a warning or throw — never silently drop data.
- **No clever abstractions yet.** We have one source and one target. The "right" abstraction will only become visible after the second adapter pair. Resist generalizing prematurely.

## File layout

```
src/
  schema/
    context.ts       # NormalizedContext type — the lingua franca
  adapters/
    base.ts          # Adapter interface
    claude-code.ts   # Source adapter for Claude Code
    codex.ts         # Target adapter for Codex CLI
  transform/
    (empty for now — add summarizer, redactor, etc. as needed)
  cli/
    index.ts         # Entry point: `can-bridge export | can-bridge import`
tests/
  fixtures/          # Real (anonymized) session files for testing
```

## Open questions tracked elsewhere

See `docs/OPEN_QUESTIONS.md` — things we'll decide once we have real data in front of us.

## Shared agent collaboration

Claude Code and Codex share work through repository files, not hidden model
context. Before changing files, read:

- `TASK_CONTEXT.md`
- `docs/HANDOFF.md`
- `docs/DECISIONS.md`
- `AGENTS.md` when changes affect Codex behavior or shared workflow

When handing work to another agent, update `docs/HANDOFF.md` with what changed,
what was verified, and what remains. Record durable project decisions in
`docs/DECISIONS.md`.
