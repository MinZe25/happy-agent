import { agentDatabaseRun } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import type { MobileDevice, MobileOwner } from "../MobileConnector.js";
import { MOBILE_DEVICES_TABLE } from "../MobileConnectorMigrations.js";

/** Persist one newly paired phone by its token's hex SHA-256. */
export async function insertMobileDevice(
    ctx: Context,
    owner: MobileOwner,
    device: MobileDevice,
    tokenHash: string,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(MOBILE_DEVICES_TABLE)}
            (id, owner_id, name, platform, token_hash, created_at, last_seen_at)
            VALUES (${device.id}, ${owner}, ${device.name}, ${device.platform}, ${tokenHash},
                ${device.createdAt}, ${device.lastSeenAt})`,
    );
}
