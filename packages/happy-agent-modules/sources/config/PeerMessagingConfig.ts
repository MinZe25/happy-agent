import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { apiTokenSchema } from "./RemoteConnectionConfig.js";

export const peerNodeIdSchema = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" });
export const peerConnectionSchema = Type.Union([
    Type.Object(
        {
            enabled: Type.Optional(Type.Literal(true)),
            role: Type.Literal("connect"),
            url: Type.String({ minLength: 6, maxLength: 2048, pattern: "^wss?://" }),
            token: apiTokenSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            enabled: Type.Optional(Type.Literal(true)),
            role: Type.Literal("accept"),
            token: apiTokenSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object({ enabled: Type.Literal(false) }, { additionalProperties: false }),
]);
export const peerMessagingConfigSchema = Type.Object(
    {
        enabled: Type.Optional(Type.Boolean()),
        listen: Type.Optional(Type.Boolean()),
        node_id: Type.Optional(peerNodeIdSchema),
        host: Type.Optional(
            Type.String({ minLength: 1, maxLength: 253, pattern: "^[A-Za-z0-9.:%_-]+$" }),
        ),
        port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
        peers: Type.Optional(
            Type.Record(peerNodeIdSchema, peerConnectionSchema, {
                additionalProperties: false,
                maxProperties: 100,
            }),
        ),
    },
    { additionalProperties: false },
);
export type PeerMessagingConfig = Static<typeof peerMessagingConfigSchema>;
export type PeerConnection = Static<typeof peerConnectionSchema>;

export function validatePeerMessagingConfig(value: unknown): asserts value is PeerMessagingConfig {
    if (!Value.Check(peerMessagingConfigSchema, value))
        throw new Error("Peer messaging settings are invalid.");
    if (value.enabled === true && value.node_id === undefined)
        throw new Error("Peer messaging requires a node ID.");
    const tokens = new Set<string>();
    for (const [id, peer] of Object.entries(value.peers ?? {})) {
        if (id === value.node_id) throw new Error("A peer cannot use this installation's node ID.");
        if (peer.enabled === false) continue;
        if (peer.role === "connect") {
            let url: URL;
            try {
                url = new URL(peer.url);
            } catch {
                throw new Error("A peer endpoint must be a WebSocket origin.");
            }
            if (
                !["ws:", "wss:"].includes(url.protocol) ||
                url.username ||
                url.password ||
                url.pathname !== "/" ||
                url.search ||
                url.hash ||
                (peer.url !== url.origin && peer.url !== `${url.origin}/`)
            ) {
                throw new Error(
                    "A peer endpoint must be a WebSocket origin without credentials, a path, query, or fragment.",
                );
            }
        }
        if (tokens.has(peer.token))
            throw new Error("Different peers require different shared tokens.");
        tokens.add(peer.token);
    }
}
