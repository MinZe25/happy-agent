/** Why a mobile connector operation was refused. */
export type MobileConnectorErrorCode =
    | "invalid_request"
    | "unauthorized"
    | "not_found"
    | "conflict"
    | "unsupported";

const STATUS: Readonly<Record<MobileConnectorErrorCode, number>> = {
    invalid_request: 400,
    unauthorized: 401,
    not_found: 404,
    conflict: 409,
    unsupported: 503,
};

/** A refused operation. Nothing changed, and the message is safe to show. */
export class MobileConnectorError extends Error {
    override readonly name = "MobileConnectorError";
    readonly code: MobileConnectorErrorCode;
    readonly status: number;

    constructor(code: MobileConnectorErrorCode, message: string) {
        super(message);
        this.code = code;
        this.status = STATUS[code];
    }
}
