import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    mobileDeviceSchema,
    mobileOwnerSchema,
    type MobileDevice,
    type MobileOwner,
} from "../MobileConnector.js";

/** The columns every device read selects, in the shape the database returns them. */
const mobileDeviceRowSchema = Type.Object({
    id: Type.String(),
    owner_id: Type.String(),
    name: Type.String(),
    platform: Type.String(),
    created_at: Type.Integer(),
    last_seen_at: Type.Integer(),
});

export interface StoredMobileDevice {
    readonly owner: MobileOwner;
    readonly device: MobileDevice;
}

/** A stored row as its device; a row that does not parse is a corrupt database. */
export function mobileDeviceFromRow(row: unknown): StoredMobileDevice {
    if (!Value.Check(mobileDeviceRowSchema, row)) {
        throw new Error("A stored mobile device is invalid.");
    }
    const device = {
        id: row.id,
        name: row.name,
        platform: row.platform,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
    };
    if (!Value.Check(mobileDeviceSchema, device) || !Value.Check(mobileOwnerSchema, row.owner_id)) {
        throw new Error("A stored mobile device is invalid.");
    }
    return { owner: row.owner_id, device };
}
