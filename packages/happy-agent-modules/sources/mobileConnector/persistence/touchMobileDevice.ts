import { agentDatabaseRows } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { MOBILE_DEVICES_TABLE } from "../MobileConnectorMigrations.js";

/**
 * Move a device's `lastSeenAt` forward to `now` when it is at least `minimumAgeMs` old. Reports
 * whether it moved, so callers announce only real changes.
 */
export async function touchMobileDevice(
    ctx: Context,
    deviceId: string,
    now: number,
    minimumAgeMs: number,
): Promise<boolean> {
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`UPDATE ${sql.raw(MOBILE_DEVICES_TABLE)} SET last_seen_at = ${now}
            WHERE id = ${deviceId} AND last_seen_at <= ${now - minimumAgeMs}
            RETURNING id`,
    );
    return rows.length > 0;
}
