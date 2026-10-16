/** A proven configuration error whose fixed explanation is safe to show during voice setup. */
export class VoiceControllerRouteError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "VoiceControllerRouteError";
    }
}
