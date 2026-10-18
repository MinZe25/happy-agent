import { agentDatabaseRows } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import type { MobileDevice, MobileOwner } from "../MobileConnector.js";
import { MOBILE_DEVICES_TABLE } from "../MobileConnectorMigrations.js";
import { mobileDeviceFromRow } from "./mobileDeviceRow.js";

/** One owner's paired phones, oldest first. */
export async function queryMobileDevices(
    ctx: Context,
    owner: MobileOwner,
): Promise<readonly MobileDevice[]> {
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`SELECT id, owner_id, name, platform, created_at, last_seen_at
            FROM ${sql.raw(MOBILE_DEVICES_TABLE)}
            WHERE owner_id = ${owner}
            ORDER BY created_at, id`,
    );
    return rows.map((row) => mobileDeviceFromRow(row).device);
}
