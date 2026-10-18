import { HappyAgentApiError, HappyAgentClient } from "@slopus/happy-agent-client";
import { expect, it, vi } from "vitest";

import { definition, ownerId, workspaceId } from "../services/support/servicesHarness.js";
import { serviceApiHarness } from "./support/serviceApiHarness.js";

it("refuses a real service attachment token on message history and the event journal", async () => {
    const f = await serviceApiHarness();
    try {
        const service = await f.services.start(f.ctx, ownerId, definition);
        await vi.waitFor(async () =>
            expect((await f.services.get(f.ctx, workspaceId, service.id)).status).toBe("running"),
        );
        const credential = await f.client.issueWorkspaceServiceAccessToken(workspaceId, service.id);
        const caller = new HappyAgentClient({
            endpoint: f.endpoint,
            token: credential.accessToken,
        });
        for (const read of [() => caller.getMessages(ownerId), () => caller.getEvents()]) {
            const outcome = await read().catch((error: unknown) => error);
            expect(outcome).toBeInstanceOf(HappyAgentApiError);
            expect((outcome as HappyAgentApiError).status).toBe(401);
            expect((outcome as HappyAgentApiError).body).toEqual({
                error: "Unauthorized",
                code: "unauthorized",
            });
        }
    } finally {
        f.finishCleanup();
        await f.close();
    }
});
