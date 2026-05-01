import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
/**
 * Claude Code stores each session as a JSONL file at:
 *   ~/.claude/projects/<project-folder>/<session-uuid>.jsonl
 *
 * The project folder is derived from the absolute cwd by replacing each
 * of `:`, `\\`, `/`, `_` with `-` (verified for Windows: cwd
 * `C:\Users\ddoon\Desktop\context_switching` →
 * folder `C--Users-ddoon-Desktop-context-switching`).
 *
 * Wrapper line shape (relevant fields):
 *   { type, uuid, parentUuid, timestamp, sessionId, cwd, gitBranch, version,
 *     message?: { role, model?, content }, attachment?: {...} }
 *
 * type values observed: permission-mode, attachment, user, assistant,
 * file-history-snapshot. Only user/assistant lines carry transcript content.
 *
 * One assistant turn can be split across multiple JSONL lines that share
 * `message.id`. The extractor coalesces them by id.
 */
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const IGNORED_TYPES = new Set([
    "permission-mode",
    "attachment",
    "file-history-snapshot",
]);
export class ClaudeCodeAdapter {
    id = "claude-code";
    // ─── SourceAdapter ────────────────────────────────────────────────
    async extract(locator) {
        const filePath = await this.resolveSessionPath(locator);
        const raw = await fs.readFile(filePath, "utf8");
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        const byUuid = new Map();
        let sessionId;
        let model;
        let firstTimestamp;
        let cwd;
        for (const line of lines) {
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch (err) {
                console.warn(`[claude-code] skipping malformed line: ${err}`);
                continue;
            }
            if (typeof entry.sessionId === "string")
                sessionId ??= entry.sessionId;
            if (typeof entry.cwd === "string")
                cwd ??= entry.cwd;
            if (typeof entry.timestamp === "string") {
                firstTimestamp ??= entry.timestamp;
            }
            const type = entry.type;
            if (typeof type !== "string")
                continue;
            const uuid = typeof entry.uuid === "string" ? entry.uuid : null;
            if (!uuid)
                continue;
            byUuid.set(uuid, {
                uuid,
                parentUuid: typeof entry.parentUuid === "string" ? entry.parentUuid : null,
                type,
                timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
                msg: entry.message,
            });
        }
        // Phase 2 — pick out the message-bearing entries.
        const messageEntries = [];
        for (const e of byUuid.values()) {
            if (IGNORED_TYPES.has(e.type))
                continue;
            if (e.type !== "user" && e.type !== "assistant")
                continue;
            if (!e.msg)
                continue;
            messageEntries.push(e);
        }
        if (messageEntries.length === 0) {
            return {
                schemaVersion: "0.1",
                source: {
                    tool: "claude-code",
                    model,
                    sessionId,
                    capturedAt: firstTimestamp,
                    cwd,
                },
                messages: [],
                metadata: { sourceFile: filePath },
            };
        }
        // Walk parentUuid skipping non-message intermediaries (attachments,
        // hooks, snapshots) until we hit another user/assistant entry.
        const messageParentCache = new Map();
        const messageParent = (uuid) => {
            const cached = messageParentCache.get(uuid);
            if (cached !== undefined)
                return cached;
            const visited = new Set([uuid]);
            let cur = byUuid.get(uuid)?.parentUuid ?? null;
            while (cur && !visited.has(cur)) {
                visited.add(cur);
                const parent = byUuid.get(cur);
                if (!parent)
                    break;
                if ((parent.type === "user" || parent.type === "assistant") &&
                    parent.msg) {
                    messageParentCache.set(uuid, parent.uuid);
                    return parent.uuid;
                }
                cur = parent.parentUuid;
            }
            messageParentCache.set(uuid, null);
            return null;
        };
        // Phase 3 — build children map among message entries.
        const childrenOf = new Map();
        for (const e of messageEntries) {
            const p = messageParent(e.uuid);
            if (!p)
                continue;
            const arr = childrenOf.get(p) ?? [];
            arr.push(e.uuid);
            childrenOf.set(p, arr);
        }
        // Phase 4 — find leaves and pick the latest by timestamp. For a linear
        // (single-chain) file there is exactly one leaf — file order preserved.
        const leaves = messageEntries.filter((e) => !childrenOf.has(e.uuid));
        const latestLeaf = leaves.reduce((best, e) => {
            if (!best)
                return e;
            const bt = best.timestamp ?? "";
            const et = e.timestamp ?? "";
            return et > bt ? e : best;
        }, null);
        // Phase 5 — walk back from the chosen leaf to root, recording the chain.
        const chainUuids = [];
        if (latestLeaf) {
            const chainVisited = new Set();
            let cur = latestLeaf.uuid;
            while (cur && !chainVisited.has(cur)) {
                chainVisited.add(cur);
                chainUuids.unshift(cur);
                cur = messageParent(cur);
            }
        }
        // Phase 6 — materialize the chain into NormalizedMessages, coalescing
        // multi-line assistant turns by message.id.
        const messagesById = new Map();
        const orderedMessages = [];
        for (const uuid of chainUuids) {
            const e = byUuid.get(uuid);
            if (!e || !e.msg)
                continue;
            const msg = e.msg;
            if (typeof msg.model === "string")
                model ??= msg.model;
            const role = msg.role === "user" || msg.role === "assistant"
                ? msg.role
                : e.type;
            const blocks = normalizeContent(msg.content);
            if (blocks.length === 0)
                continue;
            const messageId = typeof msg.id === "string" ? msg.id : undefined;
            if (messageId && messagesById.has(messageId)) {
                messagesById.get(messageId).content.push(...blocks);
                continue;
            }
            const normalized = {
                role,
                content: blocks,
                timestamp: e.timestamp,
                metadata: {
                    uuid: e.uuid,
                    parentUuid: e.parentUuid,
                    messageId,
                },
            };
            orderedMessages.push(normalized);
            if (messageId)
                messagesById.set(messageId, normalized);
        }
        return {
            schemaVersion: "0.1",
            source: {
                tool: "claude-code",
                model,
                sessionId,
                capturedAt: firstTimestamp,
                cwd,
            },
            messages: orderedMessages,
            metadata: { sourceFile: filePath },
        };
    }
    async listSessions() {
        const out = [];
        let projectDirs;
        try {
            projectDirs = await fs.readdir(CLAUDE_PROJECTS_DIR);
        }
        catch {
            return out;
        }
        for (const dir of projectDirs) {
            const full = path.join(CLAUDE_PROJECTS_DIR, dir);
            let entries;
            try {
                entries = await fs.readdir(full);
            }
            catch {
                continue;
            }
            for (const f of entries) {
                if (!f.endsWith(".jsonl"))
                    continue;
                const stat = await fs.stat(path.join(full, f));
                out.push({
                    id: f.replace(/\.jsonl$/, ""),
                    updatedAt: stat.mtime.toISOString(),
                });
            }
        }
        return out;
    }
    async resolveSessionPath(locator) {
        if (!locator) {
            throw new Error("claude-code: --session is required (id or .jsonl path)");
        }
        if (locator.endsWith(".jsonl"))
            return locator;
        const projectDirs = await fs.readdir(CLAUDE_PROJECTS_DIR);
        for (const dir of projectDirs) {
            const candidate = path.join(CLAUDE_PROJECTS_DIR, dir, `${locator}.jsonl`);
            try {
                await fs.access(candidate);
                return candidate;
            }
            catch {
                // try next
            }
        }
        throw new Error(`Could not find Claude Code session "${locator}" under ${CLAUDE_PROJECTS_DIR}`);
    }
    // ─── TargetAdapter ────────────────────────────────────────────────
    async inject(context) {
        const cwd = context.source.cwd ?? process.cwd();
        const folder = cwdToProjectFolder(cwd);
        const dir = path.join(CLAUDE_PROJECTS_DIR, folder);
        await fs.mkdir(dir, { recursive: true });
        const sessionId = crypto.randomUUID();
        const filePath = path.join(dir, `${sessionId}.jsonl`);
        const lines = buildClaudeJsonl(context, sessionId, cwd);
        await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");
        return {
            locator: filePath,
            hint: `Resume in Claude Code:\n` +
                `  cd "${cwd}"\n` +
                `  claude --resume ${sessionId}\n` +
                `\n` +
                `Or one non-interactive turn:\n` +
                `  claude --print --resume ${sessionId} "<your prompt>"\n` +
                `\n` +
                `Interactive picker fallback:\n` +
                `  claude --resume`,
            details: { sessionId, filePath, projectFolder: folder },
        };
    }
}
// ─── helpers ─────────────────────────────────────────────────────────
/**
 * Convert `C:\\Users\\ddoon\\Desktop\\context_switching` →
 * `C--Users-ddoon-Desktop-context-switching`.
 *
 * Verified rule: each of `:`, `\\`, `/`, `_` is replaced by `-`.
 */
function cwdToProjectFolder(cwd) {
    return cwd.replace(/[:\\\/_]/g, "-");
}
function normalizeContent(content) {
    if (typeof content === "string") {
        return content.length > 0 ? [{ type: "text", text: content }] : [];
    }
    if (!Array.isArray(content))
        return [];
    const blocks = [];
    for (const item of content) {
        if (!item || typeof item !== "object")
            continue;
        const b = item;
        const t = b.type;
        if (t === "text" && typeof b.text === "string") {
            if (b.text.length > 0)
                blocks.push({ type: "text", text: b.text });
        }
        else if (t === "thinking" && typeof b.thinking === "string") {
            if (b.thinking.length > 0) {
                blocks.push({ type: "thinking", text: b.thinking });
            }
        }
        else if (t === "tool_use") {
            blocks.push({
                type: "tool_use",
                id: typeof b.id === "string" ? b.id : undefined,
                name: typeof b.name === "string" ? b.name : "unknown",
                input: b.input,
            });
        }
        else if (t === "tool_result") {
            const rawContent = b.content;
            const output = typeof rawContent === "string"
                ? rawContent
                : JSON.stringify(rawContent);
            blocks.push({
                type: "tool_result",
                toolUseId: typeof b.tool_use_id === "string" ? b.tool_use_id : undefined,
                output,
                isError: b.is_error === true,
            });
        }
        else {
            console.warn(`[claude-code] unknown content block type: ${String(t)}`);
            blocks.push({ type: "text", text: JSON.stringify(b) });
        }
    }
    return blocks;
}
function buildClaudeJsonl(context, sessionId, cwd) {
    const out = [];
    let prevUuid = null;
    const fallbackTs = new Date().toISOString();
    for (const msg of context.messages) {
        const uuid = crypto.randomUUID();
        const wrapper = {
            parentUuid: prevUuid,
            isSidechain: false,
            userType: "external",
            entrypoint: "cli",
            type: msg.role === "assistant" ? "assistant" : "user",
            uuid,
            timestamp: msg.timestamp ?? fallbackTs,
            sessionId,
            cwd,
            version: "harness/0.0.1",
            message: messageToClaudeContent(msg),
        };
        out.push(JSON.stringify(wrapper));
        prevUuid = uuid;
    }
    return out;
}
function messageToClaudeContent(msg) {
    // Anthropic rules:
    //  - assistant content: array of {text|thinking|tool_use} blocks
    //  - user content: string OR array of {text|tool_result} blocks
    if (msg.role === "assistant") {
        const content = msg.content
            .map((b) => {
            if (b.type === "text")
                return { type: "text", text: b.text };
            if (b.type === "thinking") {
                return { type: "thinking", thinking: b.text, signature: "" };
            }
            if (b.type === "tool_use") {
                return {
                    type: "tool_use",
                    id: b.id ?? `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
                    name: b.name,
                    input: b.input ?? {},
                };
            }
            // tool_result doesn't belong on assistant messages — drop.
            return null;
        })
            .filter((x) => x !== null);
        return { role: "assistant", content };
    }
    // user — string when all-text, otherwise array.
    const allText = msg.content.every((b) => b.type === "text");
    if (allText) {
        return {
            role: "user",
            content: msg.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("\n\n"),
        };
    }
    const content = msg.content
        .map((b) => {
        if (b.type === "text")
            return { type: "text", text: b.text };
        if (b.type === "tool_result") {
            return {
                type: "tool_result",
                tool_use_id: b.toolUseId ?? "",
                content: b.output,
                is_error: b.isError === true,
            };
        }
        // tool_use / thinking don't belong on user messages — drop.
        return null;
    })
        .filter((x) => x !== null);
    return { role: "user", content };
}
//# sourceMappingURL=claude-code.js.map