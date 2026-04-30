# Contributing

Short guide. Most of the work in this repo is reverse-engineering
undocumented session formats — read [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md)
first to see what's known and what's still open.

## Setup

```bash
npm install
npm run build
npm test     # builds + runs round-trip + reverse-direction tests
```

Node 22.6+ is required (`tsc` toolchain).

## Adding a new tool (source or target)

1. **Find a real session file on disk.** Don't trust documentation —
   inspect a real example, note the wrapper shape, line types, and
   tool-call encoding.
2. Create `src/adapters/<your-tool>.ts` and implement `SourceAdapter`,
   `TargetAdapter`, or both, from `src/adapters/base.ts`.
3. Register the adapter in `src/cli/index.ts` (`SOURCES` / `TARGETS`).
4. Add a round-trip test in `tests/smoke.test.mjs`. Patterns to copy:
   - Norm → adapter → re-extract preserves text + `tool_use` + `tool_result`.
   - For tools with verifiable resume semantics (like Codex's
     `codex exec resume`), add a live verification snippet to
     `docs/PRESENTATION_NOTES.md`.
5. Update `docs/OPEN_QUESTIONS.md` with what's resolved and what's still
   unknown about the new format.

## Tool-call translation

Schema lives in `src/schema/context.ts` (Anthropic-style, the canonical
form). New target adapters must convert `tool_use` / `tool_result` to
their tool's native shape. See `src/adapters/codex.ts`'s
`messageToResponseItems()` for an example translating to OpenAI Responses
items, and `responseItemToMessage()` for the inverse.

## Coding conventions

- Strict TypeScript, `noUncheckedIndexedAccess`. No `any` outside the
  raw-JSON narrowing boundary.
- Pure functions in `src/transform/` and `src/schema/` — no I/O.
- I/O lives in adapters (`src/adapters/`).
- Don't add features beyond what the task requires. Resist clever
  abstractions until a second adapter pair forces them out.

## Shared agent protocol

If you're working on this with another agent (Claude Code, Codex, etc.),
follow the protocol in `AGENTS.md` / `CLAUDE.md`:

- Read `TASK_CONTEXT.md` before starting.
- Update `docs/HANDOFF.md` with what changed and what's verified.
- Use `harness mailbox` for live agent-to-agent messages.
- Record durable choices in `docs/DECISIONS.md`.
