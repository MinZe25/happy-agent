import type {
    LiveDesktopAction,
    LiveDesktopContext,
    LiveDesktopTarget,
    LiveSessionRef,
} from "@slopus/happy-agent-client";
import { liveAppStateEntities, liveTargetKey, type LiveAppStateView } from "./liveAppState.js";

/** Actions whose verified success ends a request; reads and watches need the controller's words. */
const TERMINAL = new Set<LiveDesktopAction["type"]>([
    "desktopOpen",
    "sessionSend",
    "composerDraftAppend",
    "sessionModelChange",
    "taskCreate",
]);

/**
 * The fixed, truthful outcome of a request whose every action succeeded and was terminal, composed
 * from the verified actions without another inference. Undefined when the controller must answer.
 */
export function liveFixedOutcome(
    executed: readonly LiveDesktopAction[],
    view: LiveAppStateView,
    context: LiveDesktopContext,
): string | undefined {
    if (executed.length === 0 || executed.some((action) => !TERMINAL.has(action.type)))
        return undefined;
    const entities = liveAppStateEntities(view);
    const name = (target: LiveDesktopTarget | LiveSessionRef) => {
        const key = liveTargetKey(target);
        return (
            entities.find((entity) => entity.key === key)?.name ??
            [
                ...context.sessions.map((item) => ({ ...item, name: item.title })),
                ...context.bots,
            ].find((item) => liveTargetKey(item.target) === key)?.name ??
            [...context.projects, ...context.workspaces].find(
                (item) => liveTargetKey(item.target) === key,
            )?.name ??
            ("kind" in target && target.kind === "project"
                ? "the project"
                : "kind" in target && target.kind === "workspace"
                  ? "the workspace"
                  : "the conversation")
        );
    };
    const unsent = "It has not been sent; the person must review it and press Send.";
    return executed
        .map((action) => {
            switch (action.type) {
                case "desktopOpen":
                    return `Opened ${name(action.target)}.`;
                case "sessionSend":
                    return `Staged the message in ${name(action.target)}. ${unsent}`;
                case "composerDraftAppend":
                    return `Added the text to the draft in ${name(action.target)}. Nothing was sent.`;
                case "sessionModelChange": {
                    const model = view.servers
                        .find((server) => server.connectionId === action.target.connectionId)
                        ?.models.find(
                            (candidate) =>
                                candidate.providerId === action.providerId &&
                                candidate.modelId === action.modelId,
                        );
                    const label =
                        model === undefined
                            ? action.modelId
                            : `${model.name} from ${model.providerName}`;
                    return `${name(action.target)} will use ${label} for its next message.`;
                }
                case "taskCreate":
                    return `Created ${action.name === undefined ? "a new task" : `the task ${action.name}`} and staged its opening text as a draft. ${unsent}`;
                default:
                    return "";
            }
        })
        .join(" ");
}
