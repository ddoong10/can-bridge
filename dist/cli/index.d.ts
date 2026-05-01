#!/usr/bin/env node
/**
 * can-bridge — portable context handoff for Claude Code and Codex CLI
 *
 * Usage:
 *   can-bridge export --from claude-code --session <id|path> [--out file.json]
 *   can-bridge import --to codex --in file.json
 *   can-bridge pipe   --from claude-code --session <id> --to codex
 *   can-bridge pipe   --from claude-code --session <id> --to codex --as-prompt
 *   can-bridge continue --from claude-code --to codex --latest
 *   can-bridge doctor --from codex --session <id|path> [--json]
 *   can-bridge list   --from claude-code
 */
import type { SessionSummary, SourceAdapter } from "../adapters/base.js";
export declare function pickLatestSession(source: SourceAdapter): Promise<SessionSummary>;
