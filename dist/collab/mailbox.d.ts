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
export declare function defaultMailboxPath(cwd?: string): string;
export declare function sendMessage(input: SendMailInput): Promise<AgentMailMessage>;
export declare function readMessages(mailboxPath?: string): Promise<AgentMailMessage[]>;
export declare function listInbox(agent: string, mailboxPath?: string): Promise<AgentMailMessage[]>;
export declare function listThread(threadId: string, mailboxPath?: string): Promise<AgentMailMessage[]>;
export declare function formatMessages(messages: AgentMailMessage[]): string;
