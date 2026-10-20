import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import type { ComputeModule } from "../../compute/index.js";
import type { ArtifactsModule } from "../ArtifactsModule.js";
import { artifactTitleSchema } from "../Artifact.js";
import { artifactToolDisplaySchema } from "./common.js";
import { createArtifactTool } from "./create_artifact.js";

const showPageInputSchema = Type.Object(
    {
        url: Type.String({ minLength: 1, maxLength: 4096 }),
        title: artifactTitleSchema,
        display: Type.Optional(artifactToolDisplaySchema),
    },
    { additionalProperties: false },
);
type ShowPageInput = Static<typeof showPageInputSchema>;

/** The old tool name keeps its arguments but publishes the same durable live artifact. */
export function showPageTool(artifacts: ArtifactsModule, compute: ComputeModule, agentId: string) {
    const create = createArtifactTool(artifacts, compute, agentId);
    const mapped = new WeakMap<ShowPageInput, Parameters<typeof create.execute>[1]>();
    const argumentsFor = (input: ShowPageInput) => {
        let args = mapped.get(input);
        if (args === undefined) {
            args = { ...input, type: "html" };
            mapped.set(input, args);
        }
        return args;
    };
    return defineAgentTool({
        name: "show_page",
        defer: true,
        capabilities: ["Show a running web page as a live-URL artifact."],
        searchKeywords: ["show page", "preview url", "show dev server", "inline page"],
        description:
            'Deprecated: use create_artifact with url and type "html". This tool creates the same versioned live artifact, opened through your original network in an artifact-isolated browser profile. The daemon never fetches the page.',
        parameters: showPageInputSchema,
        returnType: create.returnType,
        durable: true,
        shouldReviewInAutoMode: (input, ctx) =>
            create.shouldReviewInAutoMode(argumentsFor(input), ctx),
        describeAutoPermissionAction: (input, ctx) =>
            create.describeAutoPermissionAction!(argumentsFor(input), ctx),
        execute: (ctx, input, call) => create.execute(ctx, argumentsFor(input), call),
        toLLM: create.toLLM,
    });
}
