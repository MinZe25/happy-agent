import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigModule } from "../../sources/config/index.js";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(source = "") {
    const root = await mkdtemp(join(tmpdir(), "peer-config-"));
    roots.push(root);
    const folder = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "happy.toml"), source);
    return {
        root,
        home: join(root, ".happy"),
        config: await ConfigModule.load(join(root, ".happy")),
    };
}
const token = "p".repeat(43);
describe("machine peer messaging settings", () => {
    it("defaults to disabled and ignores project exposure and credentials", async () => {
        const f = await fixture();
        expect(f.config.peerMessaging).toEqual({});
        await writeFile(
            join(f.root, "happy.toml"),
            `[peer_messaging]\nenabled=true\nnode_id="project"\nlisten=true\n[peer_messaging.peers.remote]\nrole="connect"\nurl="ws://localhost:24780"\ntoken="${token}"\n`,
        );
        const previous = process.cwd();
        process.chdir(f.root);
        try {
            expect((await ConfigModule.load(f.home)).peerMessaging).toEqual({});
        } finally {
            process.chdir(previous);
        }
    });
    it.each([
        "ws://user:pass@localhost:24780",
        "ws://localhost:24780/path",
        "ws://localhost:24780?token=secret",
        "ws://localhost:24780#secret",
        "file:///tmp/foo",
        "ws://localhost:24780/../",
        "ws://localhost:24780?",
    ])("rejects unsafe endpoint %s without echoing credentials", async (url) => {
        const f = await fixture();
        await expect(
            f.config.updateRuntimePeerMessaging(createRootContext(), {
                node_id: "local",
                peers: { remote: { role: "connect", url, token } },
            }),
        ).rejects.toThrow();
        expect(f.config.peerMessaging).toEqual({});
    });
    it("requires node identity, a real port, unique pair tokens and a different peer node", async () => {
        const f = await fixture();
        const ctx = createRootContext();
        await expect(f.config.updateRuntimePeerMessaging(ctx, { enabled: true })).rejects.toThrow(
            "requires a node ID",
        );
        await expect(
            f.config.updateRuntimePeerMessaging(ctx, { enabled: true, node_id: "local", port: 0 }),
        ).rejects.toThrow("invalid");
        await expect(
            f.config.updateRuntimePeerMessaging(ctx, {
                node_id: "local",
                peers: { local: { role: "accept", token } },
            }),
        ).rejects.toThrow("node ID");
        await expect(
            f.config.updateRuntimePeerMessaging(ctx, {
                peers: {
                    one: { role: "connect", url: "ws://localhost:24780", token },
                    two: { role: "accept", token },
                },
            }),
        ).rejects.toThrow("Different peers");
    });
    it("merges layers and persists disabled tombstones and private runtime credentials across load", async () => {
        const f = await fixture(
            `[peer_messaging]\nnode_id="local"\nport=25001\n[peer_messaging.peers.remote]\nrole="connect"\nurl="ws://localhost:25002"\ntoken="${token}"\n`,
        );
        const changed = {
            ...f.config.peerMessaging,
            enabled: true,
            peers: {
                remote: { enabled: false as const },
                another: { role: "accept" as const, token: "r".repeat(43) },
            },
        };
        await f.config.updateRuntimePeerMessaging(createRootContext(), changed);
        expect((await ConfigModule.load(f.home)).peerMessaging).toEqual(changed);
        const path = f.config.configuration.paths.runtimeConfigPath;
        expect(await readFile(path, "utf8")).toContain("peer_messaging");
        if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    });
    it("accepts outgoing-only settings and refuses a reverse URL on an accepting peer", async () => {
        const f = await fixture();
        await f.config.updateRuntimePeerMessaging(createRootContext(), {
            enabled: true,
            node_id: "desktop",
            listen: false,
            peers: { server: { role: "connect", url: "wss://server.example", token } },
        });
        expect(f.config.peerMessaging.listen).toBe(false);
        await expect(
            f.config.updateRuntimePeerMessaging(createRootContext(), {
                peers: { desktop: { role: "accept", token, url: "ws://desktop" } },
            } as never),
        ).rejects.toThrow("invalid");
    });
});
