import type {
    LiveAppState,
    LiveAppStateServer,
    LiveControlClientMessage,
    LiveDesktopContext,
    LiveDesktopSessionStatus,
    LiveDesktopTarget,
    LiveSessionRef,
    LiveWorkspaceStatus,
} from "@slopus/happy-agent-client";

type SessionUpdate = Extract<LiveControlClientMessage, { type: "sessionUpdate" }>;

/** The startup snapshot fits GPT-Live's startup budget; later pushes are split into appends. */
export const LIVE_APP_STATE_STARTUP_BYTES = 8192;
/** One provider append: 500 UTF-8 bytes conservatively fits the 500-token limit. */
export const LIVE_APPEND_BYTES = 500;
const LATEST_MESSAGE_BYTES = 800;

/**
 * AppState with an optional server kind and an extra conversation list, so a desktop without the
 * `appState` capability can still be described from its accepted context.
 */
export type LiveAppStateView = Omit<LiveAppState, "servers"> & {
    servers: (Omit<LiveAppStateServer, "kind" | "catalog"> & {
        kind?: LiveAppStateServer["kind"];
        catalog?: LiveAppStateServer["catalog"];
        conversations?: LiveAppStateServer["projects"][number]["sessions"];
    })[];
};

/** One named sidebar entity: its target, display name, and path for speech and diffs. */
export interface LiveAppStateEntity {
    key: string;
    target: LiveDesktopTarget;
    session?: LiveSessionRef;
    connectionId: string;
    name: string;
    path: string[];
}

/** The pushed state a later update is compared against; the header time is never part of it. */
export interface LiveAppStatePushed {
    items: Map<string, { path: string; text: string }>;
    /** Each sibling list in sidebar order, keyed by its parent, so reordering is noticed. */
    order: Map<string, { label: string; entries: { key: string; name: string }[] }>;
    focus: string;
    /** The focused target's identity: two conversations may share one path. */
    focusKey: string;
    focused: string;
    truncated: boolean;
}

export function liveTargetKey(target: LiveDesktopTarget | LiveSessionRef): string {
    if (
        !("kind" in target) ||
        target.kind === "session" ||
        target.kind === "bot" ||
        target.kind === "task"
    )
        return JSON.stringify([
            "conversation",
            target.connectionId,
            target.groupId,
            target.sessionId,
        ]);
    return target.kind === "project"
        ? JSON.stringify(["project", target.connectionId, target.projectId, target.groupId])
        : JSON.stringify(["workspace", target.connectionId, target.workspaceId, target.groupId]);
}

/** Use the desktop's AppState when negotiated; otherwise describe the accepted context. */
export function liveAppStateView(
    context: LiveDesktopContext,
    appState: LiveAppState | undefined,
    updates: readonly SessionUpdate[] = [],
): LiveAppStateView {
    if (appState !== undefined) return appState;
    const sessionKeys = new Set<string>();
    const connectionIds = [
        ...context.connections.map((connection) => connection.connectionId),
        ...[...context.projects, ...context.bots, ...context.sessions].map(
            (item) => item.target.connectionId,
        ),
    ].filter((id, index, ids) => ids.indexOf(id) === index);
    const sessions = (groupId: string, connectionId: string) =>
        context.sessions
            .filter(
                (session) =>
                    session.target.connectionId === connectionId &&
                    session.target.groupId === groupId,
            )
            .map((session) => {
                sessionKeys.add(liveTargetKey(session.target));
                return { ...session, lastActivityAt: null };
            });
    const servers = connectionIds.map((connectionId) => {
        const connection = context.connections.find((item) => item.connectionId === connectionId);
        const bots = context.bots
            .filter((bot) => bot.target.connectionId === connectionId)
            .map((bot) => {
                sessionKeys.add(liveTargetKey(bot.target));
                return { ...bot, lastActivityAt: null };
            });
        const projects = context.projects
            .filter((project) => project.target.connectionId === connectionId)
            .map((project) => ({
                ...project,
                sessions: sessions(project.target.groupId, connectionId),
                workspaces: context.workspaces
                    .filter(
                        (workspace) =>
                            workspace.target.connectionId === connectionId &&
                            workspace.target.projectId === project.target.projectId,
                    )
                    .map((workspace) => ({
                        ...workspace,
                        sessions: sessions(workspace.target.groupId, connectionId),
                    })),
            }));
        return {
            connectionId,
            name: connection?.name ?? "Desktop",
            online: connection?.online ?? true,
            bots,
            tasks: [],
            projects,
            models: [],
            conversations: context.sessions
                .filter(
                    (session) =>
                        session.target.connectionId === connectionId &&
                        !sessionKeys.has(liveTargetKey(session.target)),
                )
                .map((session) => ({ ...session, lastActivityAt: null })),
        };
    });
    const active = context.activeTarget;
    const activeSession = context.activeSession;
    const update =
        activeSession === null
            ? undefined
            : updates.find(
                  (item) => liveTargetKey(item.target) === liveTargetKey(activeSession.target),
              );
    // Streaming text is not settled; a running snapshot keeps the accepted context's messages.
    const messages =
        update !== undefined && update.status !== "running"
            ? update.messages
            : (activeSession?.messages ?? []);
    const latest = messages.at(-1);
    return {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        servers,
        focused:
            active === null
                ? null
                : {
                      target: active,
                      title: null,
                      latestMessage:
                          activeSession === null ||
                          liveTargetKey(activeSession.target) !== liveTargetKey(active)
                              ? { state: "notLoaded" }
                              : latest === undefined
                                ? { state: "empty" }
                                : {
                                      state: "loaded",
                                      role: latest.role,
                                      text: latest.text,
                                      truncated: false,
                                  },
                  },
        truncated: context.truncated,
    };
}

/** Every named entity in sidebar order. */
export function liveAppStateEntities(view: LiveAppStateView): LiveAppStateEntity[] {
    const entities: LiveAppStateEntity[] = [];
    const conversation = (
        server: LiveAppStateView["servers"][number],
        session: { target: LiveSessionRef; title: string | null },
        path: string[],
    ) => {
        const name = session.title ?? "Untitled conversation";
        entities.push({
            key: liveTargetKey(session.target),
            target: { kind: "session", ...session.target },
            session: session.target,
            connectionId: server.connectionId,
            name,
            path: [...path, name],
        });
    };
    for (const server of view.servers) {
        for (const bot of server.bots)
            entities.push({
                key: liveTargetKey(bot.target),
                target: bot.target,
                session: sessionRef(bot.target),
                connectionId: server.connectionId,
                name: bot.name,
                path: [server.name, bot.name],
            });
        for (const task of server.tasks)
            entities.push({
                key: liveTargetKey(task.target),
                target: task.target,
                session: sessionRef(task.target),
                connectionId: server.connectionId,
                name: task.name,
                path: [server.name, task.name],
            });
        for (const project of server.projects) {
            const projectPath = [server.name, project.name];
            entities.push({
                key: liveTargetKey(project.target),
                target: project.target,
                connectionId: server.connectionId,
                name: project.name,
                path: projectPath,
            });
            for (const session of project.sessions) conversation(server, session, projectPath);
            for (const workspace of project.workspaces) {
                const workspacePath = [...projectPath, workspace.name];
                entities.push({
                    key: liveTargetKey(workspace.target),
                    target: workspace.target,
                    connectionId: server.connectionId,
                    name: workspace.name,
                    path: workspacePath,
                });
                for (const session of workspace.sessions)
                    conversation(server, session, workspacePath);
            }
        }
        for (const session of server.conversations ?? [])
            conversation(server, session, [server.name]);
    }
    return entities;
}

/**
 * The complete Markdown snapshot and the state later updates diff against. Only the startup
 * snapshot is bounded; a later complete push passes no bound and is split into appends instead.
 */
export function renderLiveAppState(
    view: LiveAppStateView,
    now: number,
    bytes = LIVE_APP_STATE_STARTUP_BYTES,
): { title: string; body: string; pushed: LiveAppStatePushed } {
    const clock = clockFormatter(view.timeZone, now);
    const title = `Desktop AppState — ${clock(now, true)}`;
    const pushed = pushedState(view, clock);
    const intro = pushed.focus === "" ? [] : [pushed.focus, ""];
    const outro = pushed.focused === "" ? [] : ["", pushed.focused];
    let remaining =
        bytes -
        Buffer.byteLength(`# ${title}\n\n`) -
        byteLength(intro) -
        byteLength(outro) -
        // Leave room for an explicit omission marker.
        96;
    const lines: string[] = [];
    const delivered = new Set<string>();
    let omitted = 0;
    for (const server of view.servers) {
        const block: { text: string; entity: boolean; key?: string }[] = [
            ...(lines.length === 0 ? [] : [{ text: "", entity: false }]),
            {
                text: `## ${serverLabel(server)}`,
                entity: false,
                key: JSON.stringify(["server", server.connectionId]),
            },
        ];
        const row = (text: string, target: LiveDesktopTarget | LiveSessionRef) =>
            block.push({ text, entity: true, key: liveTargetKey(target) });
        if (server.bots.length > 0) {
            block.push({ text: "### Bots", entity: false });
            for (const bot of server.bots)
                row(
                    `- ${conversationRow(bot.name, bot.status, bot.lastActivityAt, clock)}`,
                    bot.target,
                );
        }
        if (server.tasks.length > 0) {
            block.push({ text: "### Tasks", entity: false });
            for (const task of server.tasks)
                row(
                    `- ${conversationRow(task.name, task.status, task.lastActivityAt, clock)}`,
                    task.target,
                );
        }
        if (server.projects.length > 0) {
            block.push({ text: "### Projects", entity: false });
            for (const project of server.projects) {
                row(`- ${project.name}`, project.target);
                for (const session of project.sessions)
                    row(`  - ${sessionRow(session, clock)}`, session.target);
                for (const workspace of project.workspaces) {
                    row(`  - ${workspaceRow(workspace.name, workspace.status)}`, workspace.target);
                    for (const session of workspace.sessions)
                        row(`    - ${sessionRow(session, clock)}`, session.target);
                }
            }
        }
        if ((server.conversations ?? []).length > 0) {
            block.push({ text: "### Conversations", entity: false });
            for (const session of server.conversations!)
                row(`- ${sessionRow(session, clock)}`, session.target);
        }
        for (const line of block) {
            const size = Buffer.byteLength(line.text) + 1;
            if (omitted > 0 || size > remaining) {
                if (line.entity) omitted++;
                continue;
            }
            lines.push(line.text);
            if (line.key !== undefined) delivered.add(line.key);
            remaining -= size;
        }
    }
    if (omitted > 0)
        lines.push(
            `- … ${omitted} more ${omitted === 1 ? "entry" : "entries"} omitted (truncated)`,
        );
    if (view.truncated) lines.push("Some entries were omitted by the desktop (truncated).");
    if (view.servers.length === 0) lines.push("Nothing is visible in the sidebar.");
    // The next diff must still include entries the startup budget did not deliver.
    for (const key of pushed.items.keys()) if (!delivered.has(key)) pushed.items.delete(key);
    for (const list of pushed.order.values())
        list.entries = list.entries.filter((entry) => delivered.has(entry.key));
    return { title, body: [...intro, ...lines, ...outro].join("\n"), pushed };
}

/** Only what changed since the last push; undefined when nothing did. */
export function renderLiveAppStateUpdate(
    previous: LiveAppStatePushed,
    view: LiveAppStateView,
    now: number,
): { title: string; body: string; pushed: LiveAppStatePushed } | undefined {
    const clock = clockFormatter(view.timeZone, now);
    const pushed = pushedState(view, clock);
    const changed = [...pushed.items]
        .filter(([key, item]) => previous.items.get(key)?.text !== item.text)
        .map(([, item]) => `- ${item.text}`);
    const removed = [...previous.items]
        .filter(([key]) => !pushed.items.has(key))
        .map(([, item]) => `- ${item.path}`);
    // A list whose remaining entries changed relative order is listed again in its new order.
    const reordered = [...pushed.order].flatMap(([parent, list]) => {
        const before = previous.order.get(parent)?.entries.map((entry) => entry.key);
        if (before === undefined) return [];
        const after = list.entries.map((entry) => entry.key);
        const kept = after.filter((key) => before.includes(key));
        const was = before.filter((key) => after.includes(key));
        if (kept.every((key, index) => key === was[index])) return [];
        return [
            `- ${list.label}, now in this order:`,
            ...list.entries.map((entry) => `  - ${entry.name}`),
        ];
    });
    const refocused = pushed.focusKey !== previous.focusKey;
    const lines = [
        ...(pushed.focus === previous.focus && !refocused
            ? []
            : [pushed.focus || "Focused: nothing"]),
        ...(changed.length === 0 ? [] : ["Changed:", ...changed]),
        ...(removed.length === 0 ? [] : ["Removed:", ...removed]),
        ...(reordered.length === 0 ? [] : ["Reordered:", ...reordered]),
        ...(pushed.truncated === previous.truncated
            ? []
            : [
                  pushed.truncated
                      ? "Some entries were omitted by the desktop (truncated)."
                      : "The desktop no longer omits entries.",
              ]),
        // A different focused conversation is always described, even with identical text.
        ...((pushed.focused === previous.focused && !refocused) || pushed.focused === ""
            ? []
            : ["", pushed.focused]),
    ];
    if (lines.length === 0) return undefined;
    return {
        title: `Desktop AppState update — ${clock(now, true)}`,
        body: lines.join("\n"),
        pushed,
    };
}

/** Split one push into provider appends at line boundaries; nothing is truncated. */
export function liveAppStateAppends(title: string, body: string): string[] {
    const reserve = Buffer.byteLength(`# ${title} (part 999 of 999)\n`);
    const budget = LIVE_APPEND_BYTES - reserve;
    const parts: string[] = [];
    let part = "";
    const flush = () => {
        if (part !== "") parts.push(part);
        part = "";
    };
    for (const line of body.split("\n")) {
        for (const piece of splitBytes(line, budget)) {
            const next = part === "" ? piece : `${part}\n${piece}`;
            if (Buffer.byteLength(next) > budget) {
                flush();
                part = piece;
            } else part = next;
        }
    }
    flush();
    if (parts.length <= 1) return [`# ${title}\n${parts[0] ?? ""}`.trimEnd()];
    return parts.map((text, index) => `# ${title} (part ${index + 1} of ${parts.length})\n${text}`);
}

/** Controller targets stay explicit; public message bodies are fetched only when requested. */
export function liveControllerAppState(context: LiveDesktopContext, appState?: LiveAppState) {
    return {
        ...context,
        activeSession:
            context.activeSession === null
                ? null
                : {
                      target: context.activeSession.target,
                      status: context.activeSession.status,
                      composerHasDraft: context.activeSession.composerHasDraft,
                      writeRefusal: context.activeSession.writeRefusal,
                  },
        ...(appState === undefined
            ? {}
            : {
                  sidebar: appState.servers.map((server) => ({
                      connectionId: server.connectionId,
                      name: server.name,
                      online: server.online,
                      bots: server.bots.map(({ target, name, status }) => ({
                          target,
                          name,
                          status,
                      })),
                      tasks: server.tasks.map(({ target, name, status }) => ({
                          target,
                          name,
                          status,
                      })),
                      projects: server.projects.map((project) => ({
                          target: project.target,
                          name: project.name,
                          sessions: project.sessions.map(({ target, title, status }) => ({
                              target,
                              title,
                              status,
                          })),
                          workspaces: project.workspaces.map((workspace) => ({
                              target: workspace.target,
                              name: workspace.name,
                              sessions: workspace.sessions.map(({ target, title, status }) => ({
                                  target,
                                  title,
                                  status,
                              })),
                          })),
                      })),
                      models: server.models.map(({ providerId, providerName, modelId, name }) => ({
                          providerId,
                          providerName,
                          modelId,
                          name,
                      })),
                  })),
                  focused:
                      appState.focused === null
                          ? null
                          : { target: appState.focused.target, title: appState.focused.title },
              }),
    };
}

function pushedState(
    view: LiveAppStateView,
    clock: ReturnType<typeof clockFormatter>,
): LiveAppStatePushed {
    const items = new Map<string, { path: string; text: string }>();
    const order: LiveAppStatePushed["order"] = new Map();
    const item = (key: string, path: string[], suffix: string) => {
        const joined = path.join(" / ");
        items.set(key, { path: joined, text: joined + suffix });
    };
    const list = (parent: unknown[], label: string[], entries: { key: string; name: string }[]) => {
        if (entries.length > 0)
            order.set(JSON.stringify(parent), { label: label.join(" / "), entries });
    };
    list(
        ["servers"],
        ["Servers"],
        view.servers.map((server) => ({
            key: JSON.stringify(["server", server.connectionId]),
            name: server.name,
        })),
    );
    for (const server of view.servers) {
        const at = server.connectionId;
        item(JSON.stringify(["server", at]), [serverLabel(server)], "");
        for (const bot of server.bots)
            item(liveTargetKey(bot.target), [server.name, "Bots", bot.name], details(bot, clock));
        list(
            ["bots", at],
            [server.name, "Bots"],
            server.bots.map((bot) => ({ key: liveTargetKey(bot.target), name: bot.name })),
        );
        for (const task of server.tasks)
            item(
                liveTargetKey(task.target),
                [server.name, "Tasks", task.name],
                details(task, clock),
            );
        list(
            ["tasks", at],
            [server.name, "Tasks"],
            server.tasks.map((task) => ({ key: liveTargetKey(task.target), name: task.name })),
        );
        list(
            ["projects", at],
            [server.name, "Projects"],
            server.projects.map((project) => ({
                key: liveTargetKey(project.target),
                name: project.name,
            })),
        );
        for (const project of server.projects) {
            const path = [server.name, project.name];
            item(liveTargetKey(project.target), path, "");
            for (const session of project.sessions)
                item(
                    liveTargetKey(session.target),
                    [...path, title(session)],
                    details(session, clock),
                );
            list([liveTargetKey(project.target)], path, [
                ...project.sessions.map((session) => ({
                    key: liveTargetKey(session.target),
                    name: title(session),
                })),
                ...project.workspaces.map((workspace) => ({
                    key: liveTargetKey(workspace.target),
                    name: workspace.name,
                })),
            ]);
            for (const workspace of project.workspaces) {
                const workspacePath = [...path, workspace.name];
                item(
                    liveTargetKey(workspace.target),
                    workspacePath,
                    workspaceRow("", workspace.status),
                );
                for (const session of workspace.sessions)
                    item(
                        liveTargetKey(session.target),
                        [...workspacePath, title(session)],
                        details(session, clock),
                    );
                list(
                    [liveTargetKey(workspace.target)],
                    workspacePath,
                    workspace.sessions.map((session) => ({
                        key: liveTargetKey(session.target),
                        name: title(session),
                    })),
                );
            }
        }
        for (const session of server.conversations ?? [])
            item(
                liveTargetKey(session.target),
                [server.name, title(session)],
                details(session, clock),
            );
        list(
            ["conversations", at],
            [server.name, "Conversations"],
            (server.conversations ?? []).map((session) => ({
                key: liveTargetKey(session.target),
                name: title(session),
            })),
        );
    }
    const truncated = view.truncated;
    const focused = view.focused;
    if (focused === null) return { items, order, focus: "", focusKey: "", focused: "", truncated };
    const entity = liveAppStateEntities(view).find(
        (candidate) => candidate.key === liveTargetKey(focused.target),
    );
    const name = focused.title ?? entity?.name ?? "the selected item";
    const conversation =
        focused.target.kind === "session" ||
        focused.target.kind === "bot" ||
        focused.target.kind === "task";
    const message = focused.latestMessage;
    return {
        items,
        order,
        truncated,
        focusKey: liveTargetKey(focused.target),
        focus: `Focused: ${entity?.path.join(" / ") ?? name}`,
        focused: !conversation
            ? ""
            : [
                  `## Focused conversation: ${name}`,
                  ...(message.state === "loaded"
                      ? [
                            `Latest loaded message (${message.role}):`,
                            ...quote(clip(message.text, message.truncated)),
                        ]
                      : message.state === "empty"
                        ? ["No messages yet."]
                        : ["The latest message is not loaded."]),
              ].join("\n"),
    };
}

function quote(text: string): string[] {
    return text.split("\n").map((line) => (line === "" ? ">" : `> ${line}`));
}

/** At most 800 UTF-8 bytes on a character boundary, with an explicit marker when shortened. */
function clip(text: string, truncated: boolean): string {
    const marker = " … [clipped]";
    if (!truncated && Buffer.byteLength(text) <= LATEST_MESSAGE_BYTES) return text;
    let result = "";
    let size = 0;
    const budget = LATEST_MESSAGE_BYTES - Buffer.byteLength(marker);
    for (const character of text) {
        const width = Buffer.byteLength(character);
        if (size + width > budget) break;
        result += character;
        size += width;
    }
    return result.trimEnd() + marker;
}

function splitBytes(text: string, budget: number): string[] {
    if (Buffer.byteLength(text) <= budget) return [text];
    const pieces: string[] = [];
    let piece = "";
    let size = 0;
    for (const character of text) {
        const width = Buffer.byteLength(character);
        if (size + width > budget) {
            pieces.push(piece);
            piece = "";
            size = 0;
        }
        piece += character;
        size += width;
    }
    if (piece !== "") pieces.push(piece);
    return pieces;
}

function byteLength(lines: readonly string[]): number {
    return lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
}

function sessionRef(target: { connectionId: string; groupId: string; sessionId: string }) {
    return {
        connectionId: target.connectionId,
        groupId: target.groupId,
        sessionId: target.sessionId,
    };
}

function title(session: { title: string | null }): string {
    return session.title ?? "Untitled conversation";
}

function serverLabel(server: LiveAppStateView["servers"][number]): string {
    const facts = [
        ...(server.kind === undefined ? [] : [server.kind]),
        ...(server.online ? [] : ["offline"]),
        ...(server.catalog === "loading"
            ? ["still loading"]
            : server.catalog === "error"
              ? ["catalog unavailable"]
              : []),
    ];
    return facts.length === 0 ? server.name : `${server.name} (${facts.join(", ")})`;
}

const STATUS: Record<LiveDesktopSessionStatus, string> = {
    idle: "Idle",
    running: "Running",
    awaitingInput: "Needs input",
    waiting: "Waiting",
    error: "Error",
    unknown: "Status unknown",
};
const WORKSPACE_STATUS: Record<LiveWorkspaceStatus, string> = {
    ready: "",
    preparing: "Preparing",
    error: "Error",
    unknown: "Status unknown",
};

function details(
    item: { status: LiveDesktopSessionStatus; lastActivityAt: number | null },
    clock: ReturnType<typeof clockFormatter>,
): string {
    return ` — ${STATUS[item.status]}${item.lastActivityAt === null ? "" : ` — last activity ${clock(item.lastActivityAt)}`}`;
}

function conversationRow(
    name: string,
    status: LiveDesktopSessionStatus,
    lastActivityAt: number | null,
    clock: ReturnType<typeof clockFormatter>,
): string {
    return name + details({ status, lastActivityAt }, clock);
}

function sessionRow(
    session: {
        title: string | null;
        status: LiveDesktopSessionStatus;
        lastActivityAt: number | null;
    },
    clock: ReturnType<typeof clockFormatter>,
): string {
    return title(session) + details(session, clock);
}

function workspaceRow(name: string, status: LiveWorkspaceStatus): string {
    return WORKSPACE_STATUS[status] === "" ? name : `${name} — ${WORKSPACE_STATUS[status]}`;
}

const formatters = new Map<string, Intl.DateTimeFormat[]>();

/** Local clock times in the desktop's zone, with a short date only when not today. */
function clockFormatter(timeZone: string, now: number) {
    let zone = timeZone;
    let cached = formatters.get(zone);
    if (cached === undefined) {
        try {
            cached = [
                new Intl.DateTimeFormat("en-US", {
                    timeZone: zone,
                    hour: "numeric",
                    minute: "2-digit",
                }),
                new Intl.DateTimeFormat("en-US", {
                    timeZone: zone,
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                }),
                new Intl.DateTimeFormat("en-US", {
                    timeZone: zone,
                    month: "short",
                    day: "numeric",
                }),
            ];
        } catch {
            zone = "UTC";
            cached = [
                new Intl.DateTimeFormat("en-US", {
                    timeZone: zone,
                    hour: "numeric",
                    minute: "2-digit",
                }),
                new Intl.DateTimeFormat("en-US", {
                    timeZone: zone,
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                }),
                new Intl.DateTimeFormat("en-US", {
                    timeZone: zone,
                    month: "short",
                    day: "numeric",
                }),
            ];
        }
        if (formatters.size < 64) formatters.set(timeZone, cached);
    }
    const [time, fullDate, shortDate] = cached;
    const plain = (text: string) => text.replace(/[\u202f\u00a0]/g, " ");
    const today = fullDate!.format(now);
    const year = (at: number) =>
        fullDate!.formatToParts(at).find((part) => part.type === "year")?.value;
    return (at: number, timeOnly = false): string => {
        const clockTime = plain(time!.format(at));
        if (timeOnly || fullDate!.format(at) === today) return clockTime;
        const date = year(at) === year(now) ? shortDate!.format(at) : fullDate!.format(at);
        return `${plain(date)}, ${clockTime}`;
    };
}
