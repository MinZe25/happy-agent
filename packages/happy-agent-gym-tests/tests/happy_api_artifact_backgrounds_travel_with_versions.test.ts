import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import type { CreateArtifactRequest, UpdateArtifactRequest } from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

async function start(): Promise<AgentGym> {
    const gym = await createAgentGym({ timeoutMs: 20_000 });
    running.add(gym);
    return gym;
}

/**
 * A request naming `background`. The published client the gym uses does not type the field yet,
 * so it is added to an otherwise typed request.
 */
function withBackground<Request extends CreateArtifactRequest | UpdateArtifactRequest>(
    request: Request,
    background: string | null,
): Request {
    return { ...request, background } as Request;
}

describe("artifact backgrounds over the API", () => {
    it("shows artifacts on a transparent slot unless a version names a colour", async () => {
        const gym = await start();
        const { artifact: plain } = await gym.client.createArtifact({
            type: "markdown",
            title: "Notes",
            files: [{ path: "index.md", text: "# Notes\n" }],
        });
        expect(plain).toMatchObject({ background: null });
        expect((await gym.client.getArtifactVersion(plain.id, 1)).version).toMatchObject({
            background: null,
        });

        const { artifact: invoice } = await gym.client.createArtifact(
            withBackground(
                {
                    type: "html",
                    title: "Printable invoice",
                    files: [{ path: "index.html", text: "<p>Invoice</p>" }],
                },
                "#FFFFFF",
            ),
        );
        expect(invoice).toMatchObject({ background: "#ffffff", latestVersion: 1 });
        const before = (await gym.client.getEvents()).latestCursor;

        const { artifact: retitled } = await gym.client.updateArtifact(
            invoice.id,
            { title: "Invoice" },
            { ifMatch: invoice.version },
        );
        expect(retitled).toMatchObject({ background: "#ffffff", latestVersion: 2 });

        const { artifact: cleared } = await gym.client.updateArtifact(
            invoice.id,
            withBackground({}, null),
            { ifMatch: retitled.version },
        );
        expect(cleared).toMatchObject({ background: null, latestVersion: 3 });

        const versions = (await gym.client.listArtifactVersions(invoice.id)).versions;
        expect(versions).toMatchObject([
            { number: 3, background: null },
            { number: 2, background: "#ffffff" },
            { number: 1, background: "#ffffff" },
        ]);
        expect(versions[0]?.files).toEqual(versions[2]?.files);

        const updates = (await gym.client.getEvents({ after: before })).events.filter(
            (event) => event.type === "artifact.updated",
        );
        expect(updates.map((event) => event.payload)).toMatchObject([
            { artifactId: invoice.id, changes: { background: "#ffffff", latestVersion: 2 } },
            { artifactId: invoice.id, changes: { background: null, latestVersion: 3 } },
        ]);
    });

    it("refuses anything but a hexadecimal colour and makes no version for it", async () => {
        const gym = await start();
        await expect(
            gym.client.createArtifact(
                withBackground(
                    {
                        type: "markdown",
                        title: "Styled",
                        files: [{ path: "index.md", text: "# Styled\n" }],
                    },
                    "red",
                ),
            ),
        ).rejects.toMatchObject({ status: 400, code: "invalid_request" });

        const { artifact } = await gym.client.createArtifact({
            type: "markdown",
            title: "Styled",
            files: [{ path: "index.md", text: "# Styled\n" }],
        });
        for (const background of ["#12345", "rgb(0 0 0)", "#fff; color: red", "var(--x)", ""]) {
            await expect(
                gym.client.updateArtifact(artifact.id, withBackground({}, background), {
                    ifMatch: artifact.version,
                }),
            ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        }
        expect((await gym.client.getArtifact(artifact.id)).artifact).toMatchObject({
            latestVersion: 1,
            background: null,
        });
    });
});
