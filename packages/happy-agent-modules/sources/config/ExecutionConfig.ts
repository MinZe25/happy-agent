import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

/** The most bots one installation may give a Linux user of their own. */
export const MAX_EXECUTION_BOTS = 256;

/**
 * A Linux user name as `useradd` accepts it by default: a lowercase letter or `_`, then up to 31
 * lowercase letters, digits, `_`, or `-`. Nothing that a shell or sudo could read as an option,
 * a path, a group, or a numeric ID.
 */
export const executionUserSchema = Type.String({
    minLength: 1,
    maxLength: 32,
    pattern: "^[a-z_][a-z0-9_-]{0,31}$",
});

/** The absolute path of the `happy-agent` executable a workload user starts its runner from. */
export const executionExecutableSchema = Type.String({
    minLength: 2,
    maxLength: 4_096,
    pattern: "^/[^\\u0000-\\u001f\\u007f]*$",
});

/** One bot's own Linux user. */
export const executionBotConfigSchema = Type.Object(
    { user: executionUserSchema },
    { additionalProperties: false },
);
export type ExecutionBotConfig = Static<typeof executionBotConfigSchema>;

/**
 * Which Linux users this machine's work runs as.
 *
 * `user` runs every agent's files, commands, Git, terminals, and folders as that user, through a
 * runner the daemon starts for it with sudo. `bots` gives single bots, keyed by bot ID, a user of
 * their own for everything their agents run.
 */
export const executionConfigSchema = Type.Object(
    {
        user: executionUserSchema,
        executable: Type.Optional(executionExecutableSchema),
        bots: Type.Record(cuid2Schema, executionBotConfigSchema, {
            additionalProperties: false,
            maxProperties: MAX_EXECUTION_BOTS,
        }),
    },
    { additionalProperties: false },
);
export type ExecutionConfig = Static<typeof executionConfigSchema>;
