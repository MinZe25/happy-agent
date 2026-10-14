import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import {
    peerNodeIdSchema,
    peerConnectionSchema,
    peerMessagingConfigSchema,
} from "../config/index.js";

export const peerMutationSchema = Type.Union([
    Type.Object(
        {
            kind: Type.Literal("listener"),
            settings: Type.Omit(peerMessagingConfigSchema, ["peers"]),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        { kind: Type.Literal("peer"), nodeId: peerNodeIdSchema, peer: peerConnectionSchema },
        { additionalProperties: false },
    ),
]);
export type PeerMutation = Static<typeof peerMutationSchema>;
export const peerMutationAcceptedSchema = Type.Object(
    { accepted: Type.Literal(true) },
    { additionalProperties: false },
);
export type PeerMutationAccepted = Static<typeof peerMutationAcceptedSchema>;

export const peerMessageSchema = Type.Object(
    {
        messageId: cuid2Schema,
        fromAgentId: cuid2Schema,
        toAgentId: cuid2Schema,
        text: Type.String({ minLength: 1, maxLength: 16384 }),
    },
    { additionalProperties: false },
);
export type PeerMessage = Static<typeof peerMessageSchema>;
export const peerFrameSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("hello"),
            version: Type.Literal(1),
            nodeId: peerNodeIdSchema,
            sessionId: cuid2Schema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("ready"),
            version: Type.Literal(1),
            nodeId: peerNodeIdSchema,
            sessionId: cuid2Schema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        { type: Type.Literal("message"), requestId: cuid2Schema, message: peerMessageSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("ack"),
            requestId: cuid2Schema,
            messageId: cuid2Schema,
            accepted: Type.Boolean(),
            error: Type.Optional(Type.String({ maxLength: 256 })),
        },
        { additionalProperties: false },
    ),
]);
export type PeerFrame = Static<typeof peerFrameSchema>;
export const peerAcceptedSchema = Type.Object(
    {
        messageId: cuid2Schema,
        accepted: Type.Literal(true),
    },
    { additionalProperties: false },
);
export type PeerAccepted = Static<typeof peerAcceptedSchema>;
export const peerCheckSchema = Type.Object(
    {
        nodeId: peerNodeIdSchema,
        reachable: Type.Boolean(),
        authenticated: Type.Boolean(),
        ready: Type.Boolean(),
        error: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
);
export type PeerCheck = Static<typeof peerCheckSchema>;
export const peerDebugSchema = Type.Object(
    {
        enabled: Type.Boolean(),
        nodeId: Type.Union([peerNodeIdSchema, Type.Null()]),
        listening: Type.Boolean(),
        listenEnabled: Type.Boolean(),
        host: Type.String(),
        port: Type.Integer(),
        listenerError: Type.Union([Type.String(), Type.Null()]),
        peers: Type.Array(
            Type.Object(
                {
                    nodeId: peerNodeIdSchema,
                    role: Type.Union([Type.Literal("connect"), Type.Literal("accept")]),
                    url: Type.Union([Type.String(), Type.Null()]),
                    connected: Type.Boolean(),
                    sessionId: Type.Union([cuid2Schema, Type.Null()]),
                    lastOperation: Type.Union([
                        Type.Literal("health"),
                        Type.Literal("send"),
                        Type.Null(),
                    ]),
                    lastSuccess: Type.Union([Type.Boolean(), Type.Null()]),
                    lastCheckedAt: Type.Union([Type.String(), Type.Null()]),
                    error: Type.Union([Type.String(), Type.Null()]),
                },
                { additionalProperties: false },
            ),
        ),
    },
    { additionalProperties: false },
);
export type PeerDebug = Static<typeof peerDebugSchema>;
