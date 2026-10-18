import { agentDatabaseRows } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { mobileOwnerSchema, type MobileOwner } from "../MobileConnector.js";
import { MOBILE_DEVICES_TABLE } from "../MobileConnectorMigrations.js";

const ownerRowSchema = Type.Object({ owner_id: mobileOwnerSchema });

/** Every owner with at least one paired phone; the socket stays open while this is non-empty. */
export async function queryMobileDeviceOwners(ctx: Context): Promise<readonly MobileOwner[]> {
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`SELECT DISTINCT owner_id FROM ${sql.raw(MOBILE_DEVICES_TABLE)} ORDER BY owner_id`,
    );
    return rows.map((row) => {
        if (!Value.Check(ownerRowSchema, row))
            throw new Error("A stored mobile device is invalid.");
        return row.owner_id;
    });
}
