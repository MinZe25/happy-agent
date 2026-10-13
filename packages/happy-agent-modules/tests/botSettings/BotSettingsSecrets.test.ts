import type { AnyAgentTool } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import { DEFAULT_BOT_SETTINGS } from "../../sources/botSettings/index.js";
import { SecretsModule } from "../../sources/secrets/SecretsModule.js";
import { governedTree } from "./support.js";

const SECRETS = [
    ["allowed", "ALLOWED_TOKEN", "allowed-value"],
    ["projectonly", "PROJECT_TOKEN", "project-value"],
    ["workspaceonly", "WORKSPACE_TOKEN", "workspace-value"],
    ["agentonly", "AGENT_TOKEN", "agent-value"],
] as const;

/** A bot's subtask working in a project workspace that carries its own attachments. */
async function secretsWorld(name: string) {
    const secrets = new SecretsModule();
    const tree = await governedTree(name, secrets.migrations);
    const governed = new SecretsModule(tree.botSettings);
    for (const [id, variable, value] of SECRETS) {
        await governed.createCatalogSecret(tree.ctx, {
            id,
            description: `${id} credentials`,
            environment: { [variable]: value },
        });
    }
    await governed.attachCatalogSecret(tree.ctx, "allowed", { type: "project", id: "projectone" });
    await governed.attachCatalogSecret(tree.ctx, "projectonly", {
        type: "project",
        id: "projectone",
    });
    await governed.attachCatalogSecret(tree.ctx, "workspaceonly", {
        type: "workspace",
        id: "workspaceone",
    });
    await governed.attachCatalogSecret(tree.ctx, "agentonly", {
        type: "agent",
        id: "subtaskagent",
    });
    const targets = (agentId: string) =>
        [
            { type: "agent" as const, id: agentId },
            { type: "workspace" as const, id: "workspaceone" },
            { type: "project" as const, id: "projectone" },
        ] as const;
    const tools = async (agentId: string): Promise<Record<string, AnyAgentTool>> => {
        const list = (await governed.beforeStart().tools?.(tree.ctx, tree.scope(agentId))) ?? [];
        return Object.fromEntries(list.map((tool) => [tool.name, tool]));
    };
    const run = async (tool: AnyAgentTool | undefined, input: unknown): Promise<unknown> =>
        await tool!.execute(tree.ctx, input as never, undefined as never);
    const restrict = async (allowedSecretIds: readonly string[] | null) =>
        await tree.botSettings.write(tree.ctx, "botagent", {
            ...DEFAULT_BOT_SETTINGS,
            allowedSecretIds: allowedSecretIds === null ? null : [...allowedSecretIds],
        });
    return { ...tree, governed, targets, tools, run, restrict };
}

describe("bot settings secrets allowlist", () => {
    it("bounds a command's inherited project and workspace grants by the bot's allowlist", async () => {
        const world = await secretsWorld("bot-settings-secrets-resolution");
        try {
            const { governed, ctx, targets } = world;
            // Unrestricted, the subtask gets the union of every grant where it works.
            await expect(
                governed.resolveForCommandTargets(ctx, targets("subtaskagent")),
            ).resolves.toMatchObject({
                environment: {
                    ALLOWED_TOKEN: "allowed-value",
                    PROJECT_TOKEN: "project-value",
                    WORKSPACE_TOKEN: "workspace-value",
                    AGENT_TOKEN: "agent-value",
                },
            });

            await world.restrict(["allowed"]);
            // The default selection drops what the bot does not allow, wherever it was attached.
            await expect(
                governed.resolveForCommandTargets(ctx, targets("subtaskagent")),
            ).resolves.toMatchObject({ environment: { ALLOWED_TOKEN: "allowed-value" } });
            await expect(
                governed.resolveForCommandTargets(ctx, targets("collaboratoragent"), ["allowed"]),
            ).resolves.toMatchObject({ environment: { ALLOWED_TOKEN: "allowed-value" } });
            // An explicit selection of an inherited grant outside the allowlist is refused.
            for (const secretId of ["projectonly", "workspaceonly", "agentonly"]) {
                await expect(
                    governed.resolveForCommandTargets(ctx, targets("subtaskagent"), [secretId]),
                ).rejects.toThrow(`Secret '${secretId}' is not available to this bot.`);
            }
            // The same project and workspace still serve an agent no bot restricts.
            await expect(
                governed.resolveForCommandTargets(ctx, targets("otherchild"), ["projectonly"]),
            ).resolves.toMatchObject({ environment: { PROJECT_TOKEN: "project-value" } });

            await world.restrict([]);
            await expect(
                governed.resolveForCommandTargets(ctx, targets("botagent")),
            ).resolves.toMatchObject({ environment: {} });
        } finally {
            world.close();
        }
    });

    it("shows and changes only allowed secrets through every agent-facing tool", async () => {
        const world = await secretsWorld("bot-settings-secrets-tools");
        try {
            await world.restrict(["allowed"]);
            const tools = await world.tools("collaboratoragent");

            const listed = (await world.run(tools.list_secrets, {})) as {
                secrets: readonly { id: string }[];
            };
            expect(listed.secrets.map((secret) => secret.id)).toEqual(["allowed"]);
            await expect(world.run(tools.reference_secret, { id: "projectonly" })).resolves.toEqual(
                {
                    secret: null,
                },
            );
            await expect(
                world.run(tools.reference_secret, { id: "allowed" }),
            ).resolves.toMatchObject({
                secret: { id: "allowed" },
            });

            for (const [tool, input] of [
                [tools.attach_secret, { secretId: "projectonly" }],
                [tools.detach_secret, { secretId: "agentonly" }],
                [tools.update_secret, { secretId: "projectonly", description: "Taken over" }],
            ] as const) {
                await expect(world.run(tool, input)).rejects.toThrow(
                    `Secret "${input.secretId}" is not available to this bot.`,
                );
            }
            await expect(
                world.run(tools.create_secret, {
                    id: "smuggled",
                    description: "A new secret",
                    environment: { SMUGGLED: "value" },
                }),
            ).rejects.toThrow("cannot create secrets");
            await expect(
                world.governed.catalogSecret(world.ctx, "smuggled"),
            ).resolves.toBeUndefined();
            await expect(
                world.governed.catalogSecret(world.ctx, "projectonly"),
            ).resolves.toMatchObject({
                description: "projectonly credentials",
            });

            // An allowed secret is still usable through the same tools.
            await expect(
                world.run(tools.attach_secret, { secretId: "allowed" }),
            ).resolves.toMatchObject({
                attachment: { target: { type: "agent", id: "collaboratoragent" } },
            });
            await expect(
                world.run(tools.detach_secret, { secretId: "allowed" }),
            ).resolves.toMatchObject({
                detached: true,
            });
        } finally {
            world.close();
        }
    });

    it("leaves an empty allowlist with nothing to list and an ungoverned agent unrestricted", async () => {
        const world = await secretsWorld("bot-settings-secrets-empty");
        try {
            await world.restrict([]);
            const governed = await world.tools("subtaskagent");
            await expect(world.run(governed.list_secrets, {})).resolves.toMatchObject({
                secrets: [],
            });

            const ungoverned = await world.tools("otherchild");
            const listed = (await world.run(ungoverned.list_secrets, {})) as {
                secrets: readonly { id: string }[];
            };
            expect(listed.secrets.map((secret) => secret.id).sort()).toEqual([
                "agentonly",
                "allowed",
                "projectonly",
                "workspaceonly",
            ]);
            // The owner's own catalog view is never narrowed by a bot.
            const page = await world.governed.listCatalog(world.ctx);
            expect(page.secrets).toHaveLength(4);
        } finally {
            world.close();
        }
    });
});
