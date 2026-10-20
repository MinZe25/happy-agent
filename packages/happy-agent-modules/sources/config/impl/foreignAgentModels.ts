import { readFileSync, statSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { acpDiscoverModels, type ForeignAgentModel } from "@slopus/happy-providers";

import type { HappyAgentConfiguration } from "../ConfigModule.js";
import {
    foreignAgentDirectory,
    foreignAgentStart,
    type ForeignAgentRoute,
} from "./createForeignAgentProvider.js";
import { pickHarnessModels } from "./harnesses.js";

/** The models one route last reported, read again only when the file changes. */
const cached = new Map<
    string,
    { readonly mtimeMs: number; readonly models: readonly ForeignAgentModel[] }
>();

function modelsPath(agentHome: string, route: ForeignAgentRoute): string {
    return join(foreignAgentDirectory(agentHome, route), "models.json");
}

/**
 * The models one route offers, in the agent's own order and then picked and ordered by the
 * harness's `include_models` and `exclude_models`: what the agent reported when it was last
 * asked, or its built-in list until it has answered once. OpenCode and ACP agents have no built-in
 * list and offer nothing until they answer.
 */
export function foreignAgentModels(
    agentHome: string,
    route: ForeignAgentRoute,
): readonly ForeignAgentModel[] {
    const models = reportedModels(modelsPath(agentHome, route)) ?? route.agent.models;
    return pickHarnessModels(models, route.harness.includeModels, route.harness.excludeModels);
}

function reportedModels(path: string): readonly ForeignAgentModel[] | undefined {
    let mtimeMs: number;
    try {
        mtimeMs = statSync(path).mtimeMs;
    } catch {
        return undefined;
    }
    const hit = cached.get(path);
    if (hit?.mtimeMs === mtimeMs) return hit.models;
    try {
        const models = JSON.parse(readFileSync(path, "utf8")) as ForeignAgentModel[];
        cached.set(path, { mtimeMs, models });
        return models;
    } catch {
        return undefined;
    }
}

/**
 * Ask the agent which models its signed-in account serves and remember the answer. An agent that
 * reports none, or cannot be asked, keeps what was known.
 */
export async function refreshForeignAgentModels(
    configuration: HappyAgentConfiguration,
    route: ForeignAgentRoute,
): Promise<void> {
    const agentHome = configuration.paths.agentHome;
    const cwd = join(foreignAgentDirectory(agentHome, route), "detached");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const values = await acpDiscoverModels(route.agent.connect(foreignAgentStart(route)), cwd);
    const models = route.agent.modelsFromSelector(values);
    if (models.length === 0) return;
    const path = modelsPath(agentHome, route);
    const next = JSON.stringify(models);
    try {
        if (readFileSync(path, "utf8") === next) return;
    } catch {
        // Written below.
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, next, { mode: 0o600 });
    await rename(temporary, path);
}
