import { createHash } from "node:crypto";

/**
 * The agent message ID for one message to an exported bot. It is derived from the message's identity
 * on its service, so taking in the same message again — after a crash, or because the service sent
 * it twice — offers the agent a message it already has rather than a second copy.
 */
export function exportedBotMessageId(kind: string, account: string, messageId: string): string {
    const digest = createHash("sha256").update(`${kind}:${account}:${messageId}`).digest("hex");
    return `t${digest.slice(0, 31)}`;
}
