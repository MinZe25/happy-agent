import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    bridgeTokenAccount,
    bridgeTokenHash,
    bridgeTokenMatches,
    newBridgeAccount,
    newBridgeToken,
} from "../../sources/exportedBots/bridge/BridgeSettings.js";
import {
    InboundAttachmentError,
    readInboundAttachments,
} from "../../sources/exportedBots/impl/readInboundAttachments.js";

/** A 1×1 PNG. */
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
);

const folders: string[] = [];

afterEach(async () => {
    await Promise.all(folders.map(async (folder) => await rm(folder, { recursive: true })));
    folders.length = 0;
});

async function folder(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "exported-bot-files-"));
    folders.push(path);
    return path;
}

describe("bridge tokens", () => {
    it("name their export's account and are recognized only by their hash", () => {
        const account = newBridgeAccount();
        const token = newBridgeToken(account);
        const settings = { service: "Slack", tokenHash: bridgeTokenHash(token) };

        expect(bridgeTokenAccount(token)).toBe(account);
        expect(settings.tokenHash).not.toContain(token.slice(-43));
        expect(bridgeTokenMatches(settings, token)).toBe(true);
        expect(bridgeTokenMatches(settings, newBridgeToken(account))).toBe(false);
        expect(bridgeTokenAccount("not a token")).toBeUndefined();
        expect(bridgeTokenAccount(`heb1.${account}.short`)).toBeUndefined();
    });
});

describe("files a person sent through a bridge", () => {
    it("shows a picture and names any other file by its path", async () => {
        const dir = await folder();
        await writeFile(join(dir, "dot.png"), PNG);
        await writeFile(join(dir, "notes.csv"), "a,b\n1,2\n");

        const files = await readInboundAttachments([
            { path: join(dir, "dot.png"), mimeType: "image/png" },
            { path: join(dir, "notes.csv"), mimeType: "text/csv", name: "numbers.csv" },
        ]);

        expect(files.images).toHaveLength(1);
        expect(files.images[0]!.mimeType).toBe("image/png");
        expect(files.notes).toEqual([
            `(They attached "numbers.csv", text/csv, 8 bytes, saved at ${join(dir, "notes.csv")}.)`,
        ]);
    });

    it("refuses relative paths, links, directories, missing and empty files", async () => {
        const dir = await folder();
        await writeFile(join(dir, "real.png"), PNG);
        await writeFile(join(dir, "empty.txt"), "");
        await symlink(join(dir, "real.png"), join(dir, "link.png"));

        const refusal = async (path: string) =>
            await readInboundAttachments([{ path }]).then(
                () => undefined,
                (error: unknown) =>
                    error instanceof InboundAttachmentError ? error.message : error,
            );

        expect(await refusal("real.png")).toBe("Attachment 1 is not an absolute path.");
        expect(await refusal(join(dir, "link.png"))).toBe(
            "Attachment 1 is not a regular file that can be read.",
        );
        expect(await refusal(dir)).toBe("Attachment 1 is not a regular file.");
        expect(await refusal(join(dir, "missing.png"))).toBe("Attachment 1 does not exist.");
        expect(await refusal(join(dir, "empty.txt"))).toBe("Attachment 1 is empty.");
    });

    it("names a file that only claims to be a picture instead of showing it", async () => {
        const dir = await folder();
        await writeFile(join(dir, "fake.png"), "not a picture");

        const files = await readInboundAttachments([{ path: join(dir, "fake.png") }]);

        expect(files.images).toEqual([]);
        expect(files.notes[0]).toContain('"fake.png", application/octet-stream');
    });
});
