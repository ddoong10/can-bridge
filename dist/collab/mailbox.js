import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
export function defaultMailboxPath(cwd = process.cwd()) {
    return path.join(cwd, ".agent-chat", "messages.jsonl");
}
export async function sendMessage(input) {
    const mailboxPath = input.mailboxPath ?? defaultMailboxPath();
    const message = {
        id: randomUUID(),
        threadId: input.threadId ?? input.replyTo ?? randomUUID(),
        from: normalizeAgentName(input.from, "from"),
        to: normalizeAgentName(input.to, "to"),
        body: input.body,
        createdAt: new Date().toISOString(),
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    };
    if (!message.body.trim()) {
        throw new Error("Message body cannot be empty");
    }
    await fs.mkdir(path.dirname(mailboxPath), { recursive: true });
    await fs.appendFile(mailboxPath, JSON.stringify(message) + "\n", "utf8");
    return message;
}
export async function readMessages(mailboxPath) {
    const resolvedPath = mailboxPath ?? defaultMailboxPath();
    let raw = "";
    try {
        raw = await fs.readFile(resolvedPath, "utf8");
    }
    catch (err) {
        if (isNotFound(err))
            return [];
        throw err;
    }
    const messages = [];
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const [index, line] of lines.entries()) {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch (err) {
            throw new Error(`Invalid mailbox JSON at ${resolvedPath}:${index + 1}: ${err instanceof Error ? err.message : String(err)}`);
        }
        messages.push(parseMessage(parsed, resolvedPath, index + 1));
    }
    return messages;
}
export async function listInbox(agent, mailboxPath) {
    const normalized = normalizeAgentName(agent, "agent");
    const messages = await readMessages(mailboxPath);
    return messages.filter((message) => message.to === normalized);
}
export async function listThread(threadId, mailboxPath) {
    const messages = await readMessages(mailboxPath);
    return messages.filter((message) => message.threadId === threadId);
}
export function formatMessages(messages) {
    if (messages.length === 0)
        return "(no messages)\n";
    const chunks = messages.map((message) => {
        const subject = message.subject ? `\nsubject: ${message.subject}` : "";
        const replyTo = message.replyTo ? `\nreply_to: ${message.replyTo}` : "";
        return [
            `id: ${message.id}`,
            `thread: ${message.threadId}`,
            `from: ${message.from}`,
            `to: ${message.to}`,
            `created: ${message.createdAt}${subject}${replyTo}`,
            "",
            message.body,
        ].join("\n");
    });
    return chunks.join("\n\n---\n\n") + "\n";
}
function normalizeAgentName(value, field) {
    const normalized = value.trim().toLowerCase();
    if (!normalized)
        throw new Error(`Missing ${field}`);
    return normalized;
}
function parseMessage(value, mailboxPath, line) {
    if (!isRecord(value)) {
        throw new Error(`Invalid mailbox message at ${mailboxPath}:${line}`);
    }
    const id = readString(value, "id", mailboxPath, line);
    const threadId = readString(value, "threadId", mailboxPath, line);
    const from = readString(value, "from", mailboxPath, line);
    const to = readString(value, "to", mailboxPath, line);
    const body = readString(value, "body", mailboxPath, line);
    const createdAt = readString(value, "createdAt", mailboxPath, line);
    const subject = readOptionalString(value, "subject", mailboxPath, line);
    const replyTo = readOptionalString(value, "replyTo", mailboxPath, line);
    return {
        id,
        threadId,
        from,
        to,
        body,
        createdAt,
        ...(subject ? { subject } : {}),
        ...(replyTo ? { replyTo } : {}),
    };
}
function readString(record, key, mailboxPath, line) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Invalid mailbox field "${key}" at ${mailboxPath}:${line}`);
    }
    return value;
}
function readOptionalString(record, key, mailboxPath, line) {
    const value = record[key];
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Invalid mailbox field "${key}" at ${mailboxPath}:${line}`);
    }
    return value;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNotFound(err) {
    return isRecord(err) && err.code === "ENOENT";
}
//# sourceMappingURL=mailbox.js.map