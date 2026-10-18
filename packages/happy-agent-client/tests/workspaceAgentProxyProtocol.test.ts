import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/index.js";

describe("agent-scoped workspace proxy", () => {
    it("addresses one agent's proxy beneath its workspace, including through a connection", () => {
        const client = new HappyAgentClient({
            endpoint: "http://daemon/prefix?transport=key",
            token: "daemon-credential",
            fetch: async () => Response.json({}),
        });

        const local = new URL(client.workspaceAgentProxyUrl("workspace1", "agent1"));
        expect(local.pathname).toBe("/prefix/v0/workspaces/workspace1/agents/agent1/proxy");
        expect(local.searchParams.get("transport")).toBe("key");
        expect(new URL(client.workspaceProxyUrl("workspace1")).pathname).toBe(
            "/prefix/v0/workspaces/workspace1/proxy",
        );
        expect(
            new URL(client.connection("build-box").workspaceAgentProxyUrl("workspace1", "agent1"))
                .pathname,
        ).toBe("/prefix/v0/connections/build-box/api/v0/workspaces/workspace1/agents/agent1/proxy");
    });
});
