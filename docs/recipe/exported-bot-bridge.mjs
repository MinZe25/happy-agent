#!/usr/bin/env node
// A reference bridge for a Happy bot exported through a bridge, speaking protocol 1 from
// docs/exported-bot-protocol.md. The "chat service" is this terminal: each line you type is a
// message from one person, "/attach <path> [text]" sends a file with it, "/as <user ID> [name]"
// switches who is typing, and the bot's replies are printed with the person they are for.
// A real bridge keeps the same shape and swaps the terminal for its service's API.
//
//   node exported-bot-bridge.mjs <token file> <connect URL> [user ID] [display name]
//
// It needs the `ws` package installed next to it.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import WebSocket from "ws";

const [tokenFile, connectUrl, firstUserId = "terminal", firstName = "Terminal user"] =
    process.argv.slice(2);
if (tokenFile === undefined || connectUrl === undefined) {
    console.error(
        "Usage: node exported-bot-bridge.mjs <token file> <connect URL> [user ID] [display name]",
    );
    process.exit(2);
}
const token = readFileSync(tokenFile, "utf8").trim();
/** Who is typing now. Each person has one private chat, named after them. */
let person = { userId: firstUserId, name: firstName };

/** Messages sent but not yet answered, by ID. Each is sent again, unchanged, after a reconnect. */
const unanswered = new Map();
/** The highest reply delivered, so a reply repeated after a reconnect is shown only once. */
let delivered = 0;
let socket;
let retryMs = 1_000;
let typing = false;

function connect() {
    const current = new WebSocket(connectUrl, { headers: { authorization: `Bearer ${token}` } });
    let refused = false;
    socket = current;
    current.on("unexpected-response", (_request, response) => {
        refused = true;
        response.resume();
        current.terminate();
        if (response.statusCode === 503)
            return retry("Happy Agent is not ready for this exported bot");
        console.error(
            response.statusCode === 401
                ? "The bridge token was refused: it was rotated, or the bot is no longer exported."
                : `Happy Agent refused the connection (HTTP ${response.statusCode}).`,
        );
        process.exit(1);
    });
    current.on("message", (data) => receive(JSON.parse(String(data))));
    current.on("close", (code) => {
        if (refused) return;
        if (code === 4000) {
            console.error("Another bridge connected with this token, so this one stops.");
            process.exit(1);
        }
        // 4001 means the export changed; reconnecting finds out whether it still exists.
        retry(code === 4001 ? "The export changed" : "The connection closed", code === 4001);
    });
    current.on("error", () => {}); // "close" follows and reconnects.
}

function retry(reason, soon = false) {
    const delay = soon ? 0 : retryMs;
    retryMs = Math.min(retryMs * 2, 60_000);
    console.error(`${reason}; reconnecting in ${Math.round(delay / 1_000)} s.`);
    setTimeout(connect, delay);
}

function receive(frame) {
    switch (frame.type) {
        case "hello":
            retryMs = 1_000;
            console.log(
                `Connected to ${frame.bot.name}. Type a message, /attach <path> [text], or /as <user ID> [name].`,
            );
            for (const message of unanswered.values()) send(message);
            break;
        case "ack":
            unanswered.delete(frame.id);
            break;
        case "reject":
            if (frame.id !== undefined) unanswered.delete(frame.id);
            console.error(`Happy Agent refused that message: ${frame.reason}`);
            break;
        case "typing":
            if (!typing) console.log("(typing…)");
            typing = true;
            break;
        case "reply":
            typing = false;
            if (frame.seq > delivered) {
                console.log(`\n[reply ${frame.seq} to ${frame.userId}]`);
                if (frame.text !== undefined) console.log(`${frame.text}\n`);
                for (const file of frame.attachments ?? []) {
                    // A real bridge uploads the file to its service; the path is read-only.
                    console.log(
                        `[${file.name}, ${file.mimeType}, ${file.size} bytes: ${file.path}]`,
                    );
                }
                delivered = frame.seq;
            }
            // Acknowledge only once the reply is delivered, so Happy keeps it until then.
            send({ type: "ack", seq: frame.seq });
            break;
        // Frame types this bridge does not know are ignored, as the protocol requires.
    }
}

function send(frame) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

createInterface({ input: process.stdin }).on("line", (line) => {
    const as = /^\/as\s+(\S+)\s*(.*)$/.exec(line);
    if (as !== null) {
        person = { userId: as[1], name: as[2].trim() === "" ? as[1] : as[2].trim() };
        console.log(`Now typing as ${person.name}.`);
        return;
    }
    const attach = /^\/attach\s+(\S+)\s*(.*)$/.exec(line);
    const text = (attach === null ? line : attach[2]).trim();
    if (text === "" && attach === null) return;
    const message = {
        type: "message",
        id: randomUUID(), // Unique forever, so a message sent twice is taken in once.
        userId: person.userId,
        chatId: person.userId,
        name: person.name,
        ...(text === "" ? {} : { text }),
        // Paths must be absolute, on the daemon's machine, and readable by it.
        ...(attach === null ? {} : { attachments: [{ path: resolve(attach[1]) }] }),
    };
    unanswered.set(message.id, message);
    send(message);
});

connect();
