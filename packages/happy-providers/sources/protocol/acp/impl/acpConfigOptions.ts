import type * as acp from "@agentclientprotocol/sdk";

import type { AcpConfigOptionValue } from "@/protocol/acp/AcpProvider.js";

/** One value an agent's select option accepts. */
export interface AcpSelectValue {
    readonly value: string;
    readonly name: string;
    /** What the agent attached to the value, such as a model's efforts. */
    readonly meta?: Readonly<Record<string, unknown>>;
}

/** Every value a select option accepts, flattening grouped options. Booleans accept none. */
export function acpSelectValues(option: acp.SessionConfigOption): readonly AcpSelectValue[] {
    if (option.type !== "select") return [];
    return option.options.flatMap((entry) =>
        "options" in entry ? entry.options.map(selectValue) : [selectValue(entry)],
    );
}

function selectValue(option: acp.SessionConfigSelectOption): AcpSelectValue {
    return {
        value: option.value,
        name: option.name,
        ...(option._meta == null ? {} : { meta: option._meta }),
    };
}

/**
 * Whether the agent accepts `value` for `configId`, judged by the options it last advertised.
 * An option the agent never advertised, or one advertised without a closed list, is attempted.
 */
export function acpAcceptsConfigValue(
    advertised: readonly acp.SessionConfigOption[] | undefined,
    configId: string,
    value: string | boolean,
): boolean {
    const option = advertised?.find((candidate) => candidate.id === configId);
    if (option === undefined) return true;
    if (option.type === "boolean") return typeof value === "boolean";
    return typeof value === "string" && acpSelectValues(option).some((v) => v.value === value);
}

/**
 * The agent's ID for a wanted option. One wanted by category resolves to the agent's option of
 * that category, or to none when the agent advertises none.
 */
export function acpConfigOptionId(
    advertised: readonly acp.SessionConfigOption[] | undefined,
    wanted: AcpConfigOptionValue,
): string | undefined {
    if (wanted.category === undefined) return wanted.configId;
    const option =
        advertised?.find((candidate) => candidate.id === wanted.configId) ??
        advertised?.find((candidate) => candidate.category === wanted.category);
    return option?.id;
}
