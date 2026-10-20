import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The SDK packages whose sources live here but which are always consumed from npm.
 *
 * pnpm gives a `workspace:*` link and a version pin two separate copies of the same package, and
 * two copies mean two copies of every class: `instanceof` fails across the seam, and an error
 * thrown by one copy is not recognized by the other. Every package therefore has to resolve to
 * the same published version, including pnpm's root override for frozen package declarations.
 */
const PUBLISHED_SDK_PACKAGES = [
    "@slopus/happy-providers",
    "@slopus/happy-agent-base",
    "@slopus/happy-agent-client",
    "@slopus/happy-agent-compute",
] as const;

const PACKAGES_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages");

async function rootOverride(dependency: string): Promise<string | undefined> {
    const manifest = JSON.parse(
        await readFile(join(PACKAGES_DIRECTORY, "..", "package.json"), "utf8"),
    ) as { pnpm?: { overrides?: Record<string, string> } };
    return manifest.pnpm?.overrides?.[dependency];
}

async function declaredVersions(dependency: string): Promise<ReadonlyMap<string, string>> {
    const found = new Map<string, string>();
    for (const entry of await readdir(PACKAGES_DIRECTORY, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestPath = join(PACKAGES_DIRECTORY, entry.name, "package.json");
        const manifest = await readFile(manifestPath, "utf8").catch(() => undefined);
        if (manifest === undefined) continue;
        const parsed = JSON.parse(manifest) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        const declared = parsed.dependencies?.[dependency] ?? parsed.devDependencies?.[dependency];
        if (declared !== undefined) found.set(entry.name, declared);
    }
    return found;
}

function publishedVersion(dependency: string, specifier: string): string {
    const aliasPrefix = `npm:${dependency}@`;
    return specifier.startsWith(aliasPrefix) ? specifier.slice(aliasPrefix.length) : specifier;
}

describe("published SDK dependencies", () => {
    for (const dependency of PUBLISHED_SDK_PACKAGES) {
        it(`resolves ${dependency} to one published version everywhere`, async () => {
            const declared = await declaredVersions(dependency);
            assert.ok(declared.size > 0, `No package declares ${dependency}.`);

            const linked = [...declared]
                .filter(([, version]) => version.startsWith("workspace:"))
                .map(([name]) => name);
            assert.deepEqual(
                linked,
                [],
                `${dependency} must come from npm, but ${linked.join(", ")} links the workspace copy.`,
            );

            const override = await rootOverride(dependency);
            for (const specifier of [
                ...declared.values(),
                ...(override === undefined ? [] : [override]),
            ])
                assert.match(
                    publishedVersion(dependency, specifier),
                    /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/iu,
                    `${dependency} must use an exact published version: ${specifier}.`,
                );
            const versions = [
                ...new Set(
                    [...declared.values()].map((specifier) =>
                        publishedVersion(dependency, override ?? specifier),
                    ),
                ),
            ];
            assert.equal(
                versions.length,
                1,
                `${dependency} resolves to more than one version: ${versions.join(", ")}.`,
            );
        });
    }
});
