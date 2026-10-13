/**
 * A short human name for a person writing to an exported bot: the name their service gives, else their
 * username, else their ID. Control characters are removed because the name reaches titles and
 * instructions.
 */
export function senderDisplayName(input: {
    readonly name: string | undefined;
    readonly username: string | undefined;
    readonly userId: string;
    readonly service: string;
}): string {
    const cleaned = (input.name ?? "")
        .replaceAll(/\p{Cc}/gu, " ")
        .replaceAll(/\s+/g, " ")
        .trim();
    // Cut by code point so a long name never ends in half an emoji.
    const name = Array.from(cleaned).slice(0, 64).join("").trim();
    if (name.length > 0) return name;
    if (input.username !== undefined) return `@${input.username}`;
    return `${input.service} user ${Array.from(input.userId).slice(0, 64).join("")}`;
}
