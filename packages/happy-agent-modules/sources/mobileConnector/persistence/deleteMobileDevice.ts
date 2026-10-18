import { agentDatabaseRows } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import type { MobileOwner } from "../MobileConnector.js";
import { MOBILE_DEVICES_TABLE } from "../MobileConnectorMigrations.js";

/** Forget one owner's phone; its token stops working. Reports whether a row was removed. */
export async function deleteMobileDevice(
    ctx: Context,
    owner: MobileOwner,
    deviceId: string,
): Promise<boolean> {
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`DELETE FROM ${sql.raw(MOBILE_DEVICES_TABLE)}
            WHERE owner_id = ${owner} AND id = ${deviceId}
            RETURNING id`,
    );
    return rows.length > 0;
}
