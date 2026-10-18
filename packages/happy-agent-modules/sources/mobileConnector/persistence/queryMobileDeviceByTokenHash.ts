import { agentDatabaseRows } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { MOBILE_DEVICES_TABLE } from "../MobileConnectorMigrations.js";
import { mobileDeviceFromRow, type StoredMobileDevice } from "./mobileDeviceRow.js";

/** The device whose token hashes to this hex SHA-256, or `undefined`. */
export async function queryMobileDeviceByTokenHash(
    ctx: Context,
    tokenHash: string,
): Promise<StoredMobileDevice | undefined> {
    const rows = await agentDatabaseRows<unknown>(
        ctx.db,
        sql`SELECT id, owner_id, name, platform, created_at, last_seen_at
            FROM ${sql.raw(MOBILE_DEVICES_TABLE)}
            WHERE token_hash = ${tokenHash}`,
    );
    return rows[0] === undefined ? undefined : mobileDeviceFromRow(rows[0]);
}
