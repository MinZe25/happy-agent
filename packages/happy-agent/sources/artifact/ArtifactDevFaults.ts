import { Type, type Static } from "@sinclair/typebox";

/** Network trouble the development server puts between a page and its data. */
export const artifactDevFaultsSchema = Type.Object(
    {
        /** Every data request fails as if the network were down, and open streams are cut. */
        offline: Type.Boolean(),
        /** Added before every data request is answered. */
        latencyMs: Type.Integer({ minimum: 0, maximum: 60_000 }),
        /** The next data requests answered `503` without being applied. */
        failNext: Type.Integer({ minimum: 0, maximum: 1_000 }),
        /**
         * The next data requests applied, and then their connection closed before any response:
         * a write that happened but whose answer was lost. Change streams are not counted.
         */
        dropNext: Type.Integer({ minimum: 0, maximum: 1_000 }),
    },
    { additionalProperties: false },
);
export type ArtifactDevFaults = Static<typeof artifactDevFaultsSchema>;

export const artifactDevFaultsPatchSchema = Type.Partial(artifactDevFaultsSchema, {
    additionalProperties: false,
});

export const NO_ARTIFACT_DEV_FAULTS: ArtifactDevFaults = {
    offline: false,
    latencyMs: 0,
    failNext: 0,
    dropNext: 0,
};
