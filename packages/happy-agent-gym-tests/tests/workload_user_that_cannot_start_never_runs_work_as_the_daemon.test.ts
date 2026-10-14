import { createAgentGym } from "@slopus/happy-agent-gym";
import { describe, expect, it } from "vitest";

const USER = "happy-gym-workload";

/**
 * A workload user's runner is started through sudo, and no test machine has that user or grants
 * that rule. The daemon must then refuse the work with the reason, through the API, rather than
 * run it on the machine it was given — the emulated one here, its own in production.
 */
describe("a workload user whose runner cannot start", () => {
    it("refuses work on this machine through the API, saying what to fix", async () => {
        const failure = await createAgentGym({
            config: `[execution]\nuser = "${USER}"\nexecutable = "/usr/local/bin/happy-agent"\n`,
            timeoutMs: 30_000,
        }).then(
            async (gym) => {
                await gym.dispose();
                return undefined;
            },
            (error: unknown) => error,
        );

        // The gym registers its workspace as a project first; that is where the daemon refuses.
        expect(failure).toMatchObject({ status: 503, code: "runner_unavailable" });
        expect((failure as Error).message).toMatch(
            new RegExp(`^Agent work cannot run as the Linux user ${USER}: `, "u"),
        );
    }, 60_000);
});
