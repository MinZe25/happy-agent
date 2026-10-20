// A stand-in for `codex app-server`: answers the driver's requests and, for each turn, sends an
// agent message delta followed immediately by turn/completed with the status the prompt names.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const reply = (result) => send({ id: message.id, result });
    switch (message.method) {
        case "initialize":
            return reply({});
        case "thread/start":
            return reply({ thread: { id: "t1" }, model: "m", reasoningEffort: null });
        case "model/list":
            return reply({ data: [], nextCursor: null });
        case "turn/start": {
            const text = message.params.input.map((item) => item.text ?? "").join("");
            reply({ turn: { id: "turn1" } });
            send({
                method: "item/agentMessage/delta",
                params: { threadId: "t1", turnId: "turn1", itemId: "i1", delta: "partial" },
            });
            send({
                method: "turn/completed",
                params: {
                    threadId: "t1",
                    turn: {
                        id: "turn1",
                        status: text.includes("fail") ? "failed" : "completed",
                        error: text.includes("fail")
                            ? { message: "exceeded retry limit, last status: 429" }
                            : null,
                    },
                },
            });
            return;
        }
        default:
            return reply({});
    }
});
