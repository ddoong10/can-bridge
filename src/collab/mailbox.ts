import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface AgentMailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  body: string;
  createdAt: string;
  subject?: string;
  replyTo?: string;
}

export interface SendMailInput {
  from: string;
  to: string;
  body: string;
  mailboxPath?: string;
  threadId?: string;
  subject?: string;
  replyTo?: string;
}

export function defaultMailboxPath(cwd = process.cwd()): string {
  return path.join(cwd, ".agent-chat", "messages.jsonl");
}

export async function sendMessage(input: SendMailInput): Promise<AgentMailMessage> {
  const mailboxPath = input.mailboxPath ?? defaultMailboxPath();
  const message: AgentMailMessage = {
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

export async function readMessages(mailboxPath?: string): Promise<AgentMailMessage[]> {
  const resolvedPath = mailboxPath ?? defaultMailboxPath();
  let raw = "";
  try {
    raw = await fs.readFile(resolvedPath, "utf8");
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }

  const messages: AgentMailMessage[] = [];
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `Invalid mailbox JSON at ${resolvedPath}:${index + 1}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    messages.push(parseMessage(parsed, resolvedPath, index + 1));
  }
  return messages;
}

export async function listInbox(
  agent: string,
  mailboxPath?: string,
): Promise<AgentMailMessage[]> {
  const normalized = normalizeAgentName(agent, "agent");
  const messages = await readMessages(mailboxPath);
  return messages.filter((message) => message.to === normalized);
}

export async function listThread(
  threadId: string,
  mailboxPath?: string,
): Promise<AgentMailMessage[]> {
  const messages = await readMessages(mailboxPath);
  return messages.filter((message) => message.threadId === threadId);
}

export function formatMessages(messages: AgentMailMessage[]): string {
  if (messages.length === 0) return "(no messages)\n";
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

function normalizeAgentName(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) throw new Error(`Missing ${field}`);
  return normalized;
}

function parseMessage(value: unknown, mailboxPath: string, line: number): AgentMailMessage {
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

function readString(
  record: Record<string, unknown>,
  key: string,
  mailboxPath: string,
  line: number,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid mailbox field "${key}" at ${mailboxPath}:${line}`);
  }
  return value;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  mailboxPath: string,
  line: number,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid mailbox field "${key}" at ${mailboxPath}:${line}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(err: unknown): boolean {
  return isRecord(err) && err.code === "ENOENT";
}
