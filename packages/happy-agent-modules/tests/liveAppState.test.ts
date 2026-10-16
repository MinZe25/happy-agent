import { describe, expect, it } from "vitest";
import type { LiveAppState, LiveDesktopContext } from "@slopus/happy-agent-client";
import {
    LIVE_APPEND_BYTES,
    liveAppStateAppends,
    liveAppStateView,
    liveControllerAppState,
    renderLiveAppState,
    renderLiveAppStateUpdate,
} from "../sources/live/impl/liveAppState.js";
import { liveMentionedTarget } from "../sources/live/impl/liveMentionedTarget.js";

/** 3:42 PM on October 12, 2026 in Los Angeles. */
const now = Date.UTC(2026, 9, 12, 22, 42);
const minutesAgo = (minutes: number) => now - minutes * 60_000;
const notes = { connectionId: "local", groupId: "garden", sessionId: "notes" };
const release = { connectionId: "local", groupId: "garden", sessionId: "release" };
const garden = {
    kind: "workspace" as const,
    connectionId: "local",
    projectId: "observatory",
    workspaceId: "garden",
    groupId: "garden",
};
const observatory = {
    kind: "project" as const,
    connectionId: "local",
    projectId: "observatory",
    groupId: "observatory",
};

function appState(): LiveAppState {
    return {
        timeZone: "America/Los_Angeles",
        servers: [
            {
                connectionId: "local",
                name: "This Mac",
                kind: "local",
                online: true,
                catalog: "ready",
                bots: [
                    {
                        target: {
                            kind: "bot",
                            connectionId: "local",
                            groupId: "bots",
                            sessionId: "happy-agent",
                            botId: "happy",
                        },
                        name: "Happy",
                        status: "running",
                        lastActivityAt: minutesAgo(2),
                    },
                ],
                tasks: [],
                projects: [
                    {
                        target: observatory,
                        name: "Observatory",
                        sessions: [],
                        workspaces: [
                            {
                                target: garden,
                                name: "Garden",
                                status: "ready",
                                sessions: [
                                    {
                                        target: notes,
                                        title: "Garden notes",
                                        status: "idle",
                                        lastActivityAt: minutesAgo(42),
                                    },
                                    {
                                        target: release,
                                        title: "Release notes",
                                        status: "idle",
                                        lastActivityAt: Date.UTC(2026, 9, 9, 22, 0),
                                    },
                                ],
                            },
                        ],
                    },
                ],
                models: [],
            },
        ],
        focused: {
            target: { kind: "session", ...notes },
            title: "Garden notes",
            latestMessage: {
                state: "loaded",
                role: "assistant",
                text: "The requested changes are complete.",
                truncated: false,
            },
        },
        truncated: false,
    };
}

const markdown = (rendered: { title: string; body: string }) =>
    `# ${rendered.title}\n\n${rendered.body}`;

describe("Desktop AppState for voice", () => {
    it("renders the sidebar as Markdown in the supplied order with local times", () => {
        const text = markdown(renderLiveAppState(appState(), now));
        expect(text).toBe(
            [
                "# Desktop AppState — 3:42 PM",
                "",
                "Focused: This Mac / Observatory / Garden / Garden notes",
                "",
                "## This Mac (local)",
                "### Bots",
                "- Happy — Running — last activity 3:40 PM",
                "### Projects",
                "- Observatory",
                "  - Garden",
                "    - Garden notes — Idle — last activity 3:00 PM",
                "    - Release notes — Idle — last activity Oct 9, 3:00 PM",
                "",
                "## Focused conversation: Garden notes",
                "Latest loaded message (assistant):",
                "> The requested changes are complete.",
            ].join("\n"),
        );
        expect(text).not.toContain("garden");
        expect(text).not.toContain("happy-agent");
    });

    it("never re-sorts servers or entries and adds the year only for another year", () => {
        const state = appState();
        const remote = structuredClone(state.servers[0]!);
        remote.connectionId = "studio";
        remote.name = "Studio";
        remote.kind = "remote";
        remote.online = false;
        remote.catalog = "loading";
        remote.bots[0]!.lastActivityAt = Date.UTC(2025, 11, 31, 20, 0);
        remote.projects = [];
        state.servers.unshift(remote);
        state.focused = null;
        const text = markdown(renderLiveAppState(state, now));
        expect(text.indexOf("## Studio (remote, offline, still loading)")).toBeLessThan(
            text.indexOf("## This Mac (local)"),
        );
        expect(text).toContain("- Happy — Running — last activity Dec 31, 2025, 12:00 PM");
        expect(text).not.toContain("Focused");
    });

    it("clips only the focused latest message at 800 bytes on a character boundary", () => {
        const state = appState();
        state.focused!.latestMessage = {
            state: "loaded",
            role: "user",
            text: "🌱".repeat(400),
            truncated: false,
        };
        const body = renderLiveAppState(state, now).body;
        const quoted = body.slice(body.indexOf("> ") + 2);
        expect(quoted.endsWith(" … [clipped]")).toBe(true);
        expect(Buffer.byteLength(quoted)).toBeLessThanOrEqual(800);
        expect(quoted).not.toContain("\uFFFD");
        state.focused!.latestMessage = { state: "notLoaded" };
        expect(renderLiveAppState(state, now).body).toContain(
            "## Focused conversation: Garden notes\nThe latest message is not loaded.",
        );
        state.focused!.latestMessage = { state: "empty" };
        expect(renderLiveAppState(state, now).body).toContain("No messages yet.");
    });

    it("bounds the startup snapshot and marks omitted entries explicitly", () => {
        const state = appState();
        state.servers[0]!.projects[0]!.workspaces[0]!.sessions = Array.from(
            { length: 100 },
            (_, index) => ({
                target: { ...notes, sessionId: `session${index}` },
                title: `🌱 ${"Conversation ".repeat(8)}${index}`,
                status: "idle" as const,
                lastActivityAt: null,
            }),
        );
        const text = markdown(renderLiveAppState(state, now));
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
        expect(text).toMatch(/- … \d+ more entries omitted \(truncated\)/u);
        expect(text).toContain("## Focused conversation: Garden notes");
    });

    it("pushes only changes, ignores the header time, and includes a newly focused conversation", () => {
        const first = renderLiveAppState(appState(), now);
        expect(renderLiveAppStateUpdate(first.pushed, appState(), now + 3_600_000)).toBeUndefined();
        const next = appState();
        next.servers[0]!.bots[0]!.status = "idle";
        next.servers[0]!.projects[0]!.workspaces[0]!.sessions.pop();
        next.focused = {
            target: next.servers[0]!.bots[0]!.target,
            title: null,
            latestMessage: {
                state: "loaded",
                role: "assistant",
                text: "Your build passed.",
                truncated: false,
            },
        };
        const update = renderLiveAppStateUpdate(first.pushed, next, now)!;
        expect(markdown(update)).toBe(
            [
                "# Desktop AppState update — 3:42 PM",
                "",
                "Focused: This Mac / Happy",
                "Changed:",
                "- This Mac / Bots / Happy — Idle — last activity 3:40 PM",
                "Removed:",
                "- This Mac / Observatory / Garden / Release notes",
                "",
                "## Focused conversation: Happy",
                "Latest loaded message (assistant):",
                "> Your build passed.",
            ].join("\n"),
        );
        expect(renderLiveAppStateUpdate(update.pushed, next, now)).toBeUndefined();
    });

    it("pushes a reorder, a different conversation with the same name and text, and truncation", () => {
        const first = renderLiveAppState(appState(), now);
        const reordered = appState();
        reordered.servers[0]!.projects[0]!.workspaces[0]!.sessions.reverse();
        expect(renderLiveAppStateUpdate(first.pushed, reordered, now)?.body).toBe(
            [
                "Reordered:",
                "- This Mac / Observatory / Garden, now in this order:",
                "  - Release notes",
                "  - Garden notes",
            ].join("\n"),
        );

        const twin = appState();
        const sessions = twin.servers[0]!.projects[0]!.workspaces[0]!.sessions;
        sessions[1]!.title = "Garden notes";
        sessions[1]!.lastActivityAt = sessions[0]!.lastActivityAt;
        const before = renderLiveAppState(twin, now);
        twin.focused = { ...twin.focused!, target: { kind: "session", ...release } };
        expect(renderLiveAppStateUpdate(before.pushed, twin, now)?.body).toBe(
            [
                "Focused: This Mac / Observatory / Garden / Garden notes",
                "",
                "## Focused conversation: Garden notes",
                "Latest loaded message (assistant):",
                "> The requested changes are complete.",
            ].join("\n"),
        );

        const truncated = appState();
        truncated.truncated = true;
        const update = renderLiveAppStateUpdate(first.pushed, truncated, now)!;
        expect(update.body).toBe("Some entries were omitted by the desktop (truncated).");
        expect(renderLiveAppStateUpdate(update.pushed, appState(), now)?.body).toBe(
            "The desktop no longer omits entries.",
        );
    });

    it("bounds only the startup snapshot; a later complete snapshot keeps every entry", () => {
        const state = appState();
        state.servers[0]!.projects[0]!.workspaces[0]!.sessions = Array.from(
            { length: 200 },
            (_, index) => ({
                target: { ...notes, sessionId: `session${index}` },
                title: `A conversation with a deliberately long descriptive name ${index}`,
                status: "idle" as const,
                lastActivityAt: null,
            }),
        );
        expect(renderLiveAppState(state, now).body).toMatch(/more entries omitted \(truncated\)/u);
        const complete = renderLiveAppState(state, now, Number.POSITIVE_INFINITY).body;
        expect(complete).not.toContain("omitted");
        expect(complete).toContain("deliberately long descriptive name 199");
        const initial = renderLiveAppState(state, now);
        const next = structuredClone(state);
        next.focused = null;
        expect(renderLiveAppStateUpdate(initial.pushed, next, now)?.body).toContain(
            "deliberately long descriptive name 199",
        );
    });

    it("splits a large push into labeled appends without losing a line", () => {
        const state = appState();
        state.servers[0]!.projects[0]!.workspaces[0]!.sessions = Array.from(
            { length: 40 },
            (_, index) => ({
                target: { ...notes, sessionId: `session${index}` },
                title: `Conversation ${index}`,
                status: "running" as const,
                lastActivityAt: null,
            }),
        );
        const update = renderLiveAppStateUpdate(
            renderLiveAppState(appState(), now).pushed,
            state,
            now,
        )!;
        const appends = liveAppStateAppends(update.title, update.body);
        expect(appends.length).toBeGreaterThan(1);
        for (const [index, text] of appends.entries()) {
            expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LIVE_APPEND_BYTES);
            expect(
                text.startsWith(`# ${update.title} (part ${index + 1} of ${appends.length})\n`),
            ).toBe(true);
        }
        expect(appends.map((text) => text.slice(text.indexOf("\n") + 1)).join("\n")).toBe(
            update.body,
        );
        expect(liveAppStateAppends("Desktop AppState update — 3:42 PM", "Focused: Happy")).toEqual([
            "# Desktop AppState update — 3:42 PM\nFocused: Happy",
        ]);
    });

    it("describes a desktop without AppState from its accepted context", () => {
        const context: LiveDesktopContext = {
            windowId: "window",
            connections: [{ connectionId: "local", name: "My Mac", online: true }],
            activeConnectionId: "local",
            activeTarget: { kind: "session", ...notes },
            projects: [{ target: observatory, name: "Observatory" }],
            workspaces: [{ target: garden, name: "Garden", status: "preparing" }],
            sessions: [
                { target: notes, title: "Garden notes", status: "idle" },
                {
                    target: { ...notes, groupId: "elsewhere", sessionId: "loose" },
                    title: null,
                    status: "error",
                },
            ],
            bots: [],
            activeSession: {
                target: notes,
                status: "idle",
                composerHasDraft: true,
                writeRefusal: null,
                messages: [{ id: "message", role: "assistant", text: "All done." }],
            },
            truncated: false,
        };
        const body = renderLiveAppState(liveAppStateView(context, undefined), now).body;
        expect(body).toContain("Focused: My Mac / Observatory / Garden / Garden notes");
        expect(body).toContain("- Observatory\n  - Garden — Preparing\n    - Garden notes — Idle");
        expect(body).toContain("### Conversations\n- Untitled conversation — Error");
        expect(body).toContain("> All done.");
        expect(liveControllerAppState(context)).toMatchObject({
            activeSession: { target: notes, composerHasDraft: true },
        });
        expect(JSON.stringify(liveControllerAppState(context))).not.toContain("All done.");
    });

    it("highlights only a uniquely named entity before the controller runs", () => {
        const state = appState();
        expect(liveMentionedTarget(state, "open garden notes please")).toEqual({
            kind: "session",
            ...notes,
        });
        expect(liveMentionedTarget(state, "Open Garden notes in Observatory")).toEqual({
            kind: "session",
            ...notes,
        });
        expect(liveMentionedTarget(state, "show me the garden")).toEqual(garden);
        expect(
            liveMentionedTarget(state, "compare garden notes with release notes"),
        ).toBeUndefined();
        expect(liveMentionedTarget(state, "Stage a message for Happy")).toEqual(
            state.servers[0]!.bots[0]!.target,
        );
        expect(liveMentionedTarget(state, "gardening tips")).toBeUndefined();
        const twin = structuredClone(state);
        twin.servers[0]!.projects[0]!.sessions.push({
            target: { ...notes, groupId: "observatory", sessionId: "twin" },
            title: "Garden notes",
            status: "idle",
            lastActivityAt: null,
        });
        expect(liveMentionedTarget(twin, "open garden notes")).toBeUndefined();
    });
});
