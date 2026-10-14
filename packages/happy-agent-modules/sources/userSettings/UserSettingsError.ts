/** Why a setting was refused: a malformed key or value, a value too large, or full settings. */
export type UserSettingsErrorCode = "invalid_request" | "too_large" | "settings_full";

/** A refused write or read. Nothing changed; the message is safe to show to the person. */
export class UserSettingsError extends Error {
    override readonly name = "UserSettingsError";
    readonly code: UserSettingsErrorCode;

    constructor(code: UserSettingsErrorCode, message: string) {
        super(message);
        this.code = code;
    }
}
