import { createHash, randomBytes } from "node:crypto";

import type {
    MobileDeviceDescription,
    MobileOwner,
    MobilePairingSnapshot,
} from "../MobileConnector.js";
import {
    bytesEqual,
    createDaemonPairingKey,
    derivePairingSecrets,
    deviceTokenHash,
    pairingCommitment,
    pairingMac,
    pairingSharedSecret,
    pairingTranscriptHash,
    type DaemonPairingKey,
    type PairingSecrets,
} from "./mobilePairingCrypto.js";

/** Pairing must finish, both confirmations included, within five minutes of the QR code. */
export const MOBILE_PAIRING_TTL_MS = 5 * 60 * 1_000;

/** Every way a pairing can end. Each leaves no device behind except `completed`. */
export type MobilePairingEnding = "rejected" | "expired" | "cancelled" | "failed";

/** What the phone learns: cancelled and failed read as `rejected`. */
export type MobilePairingPhoneStatus =
    | { readonly status: "verifying" }
    | { readonly status: "completed"; readonly deviceId: string; readonly mac: string }
    | { readonly status: "rejected" }
    | { readonly status: "expired" };

/** The values the module persists once both people have confirmed. */
export interface MobilePairingCompletion {
    readonly device: MobileDeviceDescription;
    readonly tokenHash: string;
}

type Phase =
    | { readonly kind: "waiting"; readonly qr: string | null }
    | {
          readonly kind: "committed";
          readonly commitment: Buffer;
          readonly device: MobileDeviceDescription;
          readonly daemonKey: DaemonPairingKey;
          readonly daemonNonce: Buffer;
      }
    | {
          readonly kind: "verifying";
          readonly device: MobileDeviceDescription;
          readonly secrets: PairingSecrets;
          desktopConfirmed: boolean;
          mobileConfirmed: boolean;
      }
    | {
          readonly kind: "completed";
          readonly device: MobileDeviceDescription;
          readonly emoji: readonly string[];
          readonly deviceId: string;
          readonly mac: string;
      }
    | {
          readonly kind: MobilePairingEnding;
          readonly device: MobileDeviceDescription | null;
          readonly emoji: readonly string[] | null;
          readonly mobileConfirmed: boolean;
          readonly desktopConfirmed: boolean;
          readonly error: string | null;
      };

/**
 * One pairing's memory-only state machine.
 *
 * ```text
 * waiting ──start──▶ committed ──reveal──▶ verifying ──both confirmed──▶ completed
 *    │                   │                    │
 *    └───────────────────┴────────────────────┴──▶ rejected | expired | cancelled | failed
 * ```
 *
 * The token is consumed by `start`, the daemon's private key is discarded by `reveal`, and the
 * confirmation key and device token are discarded once the device is persisted or the pairing
 * ends. Transitions are synchronous; the module serializes them and owns every side effect.
 */
export class MobilePairing {
    readonly id: string;
    readonly owner: MobileOwner;
    readonly expiresAt: number;
    /** The hex SHA-256 of the one-time token, for lookup without keeping the token by value. */
    readonly tokenHash: string;
    #token: Buffer | undefined;
    #handshakeId: string | undefined;
    #phase: Phase = { kind: "waiting", qr: null };
    /**
     * The device row is being written, so the completion is not claimed twice. A pairing can still
     * end meanwhile, for example when the caller's transaction rolls back and it later expires.
     */
    #completing = false;
    readonly #waiters = new Set<() => void>();

    constructor(id: string, owner: MobileOwner, now: number, token: Buffer = randomBytes(32)) {
        this.id = id;
        this.owner = owner;
        this.expiresAt = now + MOBILE_PAIRING_TTL_MS;
        this.#token = token;
        this.tokenHash = createHash("sha256").update(token).digest("hex");
    }

    /** The token's base64url text, for the QR code. Unavailable once the phone has used it. */
    get token(): string | undefined {
        return this.#token?.toString("base64url");
    }

    get handshakeId(): string | undefined {
        return this.#handshakeId;
    }

    /** Still able to progress: the socket must stay open while any pairing is active. */
    get active(): boolean {
        return (
            this.#phase.kind === "waiting" ||
            this.#phase.kind === "committed" ||
            this.#phase.kind === "verifying"
        );
    }

    get waitingForQr(): boolean {
        return (
            this.#phase.kind === "waiting" && this.#phase.qr === null && this.#token !== undefined
        );
    }

    isExpired(now: number): boolean {
        return now >= this.expiresAt;
    }

    /** Show the code once the socket is open and its address is known. */
    showQr(qr: string): void {
        if (this.#phase.kind !== "waiting" || this.#token === undefined) return;
        this.#phase = { kind: "waiting", qr };
        this.#changed();
    }

    /** The phone used the code: consume the token and answer with a fresh key and nonce. */
    start(
        commitment: Buffer,
        device: MobileDeviceDescription,
        daemonKey: DaemonPairingKey = createDaemonPairingKey(),
        daemonNonce: Buffer = randomBytes(32),
    ): { handshakeId: string; publicKey: string; nonce: string; expiresAt: number } {
        if (this.#phase.kind !== "waiting" || this.#token === undefined) {
            throw new Error("This pairing code has already been used.");
        }
        this.#handshakeId = randomBytes(32).toString("base64url");
        this.#phase = { kind: "committed", commitment, device, daemonKey, daemonNonce };
        this.#changed();
        return {
            handshakeId: this.#handshakeId,
            publicKey: daemonKey.publicKey.toString("base64url"),
            nonce: daemonNonce.toString("base64url"),
            expiresAt: this.expiresAt,
        };
    }

    /**
     * The phone revealed the key it committed to. A mismatch or an unusable key fails the pairing:
     * the token is single-use, so there is no second attempt.
     */
    reveal(phonePublicKey: Buffer, phoneNonce: Buffer, address: string, port: number): void {
        const phase = this.#phase;
        const token = this.#token;
        if (phase.kind !== "committed" || token === undefined) {
            throw new Error("This pairing is not waiting for the phone's key.");
        }
        this.#token = undefined;
        if (!bytesEqual(pairingCommitment(phonePublicKey, phoneNonce), phase.commitment)) {
            this.#end("failed", "The phone's key did not match the one it committed to.");
            token.fill(0);
            return;
        }
        let shared: Buffer;
        try {
            shared = pairingSharedSecret(phase.daemonKey.privateKey, phonePublicKey);
        } catch {
            this.#end("failed", "The phone sent a key that cannot be used for pairing.");
            token.fill(0);
            return;
        }
        const transcriptHash = pairingTranscriptHash({
            token,
            commitment: phase.commitment,
            phonePublicKey,
            daemonPublicKey: phase.daemonKey.publicKey,
            phoneNonce,
            daemonNonce: phase.daemonNonce,
            address,
            port,
        });
        const secrets = derivePairingSecrets(shared, transcriptHash);
        shared.fill(0);
        token.fill(0);
        this.#phase = {
            kind: "verifying",
            device: phase.device,
            secrets,
            desktopConfirmed: false,
            mobileConfirmed: false,
        };
        this.#changed();
    }

    /** The person on the phone tapped "Match". A wrong MAC fails the pairing. */
    confirmMobile(mac: Buffer): void {
        const phase = this.#requireVerifying();
        const expected = pairingMac(
            phase.secrets.confirmKey,
            phase.secrets.transcriptHash,
            "mobile",
        );
        if (!bytesEqual(expected, mac)) {
            this.#end("failed", "The phone could not prove it derived the same keys.");
            return;
        }
        phase.mobileConfirmed = true;
        this.#changed();
    }

    /** The person at the desktop clicked "Emoji match". */
    confirmDesktop(): void {
        const phase = this.#requireVerifying();
        phase.desktopConfirmed = true;
        this.#changed();
    }

    /**
     * Both confirmed: claim the completion once and return what to persist. The token itself
     * never leaves this object. The pairing becomes `completed` only after the row commits.
     */
    beginCompletion(): MobilePairingCompletion | undefined {
        const phase = this.#phase;
        if (
            this.#completing ||
            phase.kind !== "verifying" ||
            !phase.desktopConfirmed ||
            !phase.mobileConfirmed
        ) {
            return undefined;
        }
        this.#completing = true;
        return { device: phase.device, tokenHash: deviceTokenHash(phase.secrets.deviceToken) };
    }

    /**
     * The device row committed: prove it to the phone and forget every remaining secret. Returns
     * false when the pairing ended before the commit was seen, so the caller removes the row.
     */
    complete(deviceId: string): boolean {
        const phase = this.#phase;
        if (phase.kind !== "verifying" || !this.#completing) return false;
        this.#completing = false;
        const mac = pairingMac(phase.secrets.confirmKey, phase.secrets.transcriptHash, "daemon");
        this.#forget(phase);
        this.#phase = {
            kind: "completed",
            device: phase.device,
            emoji: phase.secrets.emoji,
            deviceId,
            mac: mac.toString("base64url"),
        };
        this.#changed();
        return true;
    }

    /** End an active pairing. Does nothing once it has already ended. */
    end(ending: MobilePairingEnding, error: string | null = null): void {
        if (!this.active) return;
        this.#end(ending, error);
    }

    phoneStatus(): MobilePairingPhoneStatus {
        const phase = this.#phase;
        switch (phase.kind) {
            case "waiting":
            case "committed":
            case "verifying":
                return { status: "verifying" };
            case "completed":
                return { status: "completed", deviceId: phase.deviceId, mac: phase.mac };
            case "expired":
                return { status: "expired" };
            default:
                return { status: "rejected" };
        }
    }

    snapshot(): MobilePairingSnapshot {
        const phase = this.#phase;
        const base = { id: this.id, expiresAt: this.expiresAt };
        switch (phase.kind) {
            case "waiting":
                return {
                    ...base,
                    status: "waiting",
                    qr: phase.qr,
                    device: null,
                    emoji: null,
                    desktopConfirmed: false,
                    mobileConfirmed: false,
                    error: null,
                };
            case "committed":
                return {
                    ...base,
                    status: "waiting",
                    qr: null,
                    device: { ...phase.device },
                    emoji: null,
                    desktopConfirmed: false,
                    mobileConfirmed: false,
                    error: null,
                };
            case "verifying":
                return {
                    ...base,
                    status: "verifying",
                    qr: null,
                    device: { ...phase.device },
                    emoji: [...phase.secrets.emoji],
                    desktopConfirmed: phase.desktopConfirmed,
                    mobileConfirmed: phase.mobileConfirmed,
                    error: null,
                };
            case "completed":
                return {
                    ...base,
                    status: "completed",
                    qr: null,
                    device: { ...phase.device },
                    emoji: [...phase.emoji],
                    desktopConfirmed: true,
                    mobileConfirmed: true,
                    error: null,
                };
            default:
                return {
                    ...base,
                    status: phase.kind,
                    qr: null,
                    device: phase.device === null ? null : { ...phase.device },
                    emoji: phase.emoji === null ? null : [...phase.emoji],
                    desktopConfirmed: phase.desktopConfirmed,
                    mobileConfirmed: phase.mobileConfirmed,
                    error: phase.error,
                };
        }
    }

    /** Resolve after the next change, after `timeoutMs`, or when `signal` aborts. */
    async waitForChange(timeoutMs: number, signal: AbortSignal): Promise<void> {
        if (timeoutMs <= 0 || signal.aborted) return;
        await new Promise<void>((resolve) => {
            const finish = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", finish);
                this.#waiters.delete(finish);
                resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            timer.unref();
            signal.addEventListener("abort", finish, { once: true });
            this.#waiters.add(finish);
        });
    }

    #requireVerifying(): Extract<Phase, { kind: "verifying" }> {
        const phase = this.#phase;
        if (phase.kind !== "verifying") throw new Error("This pairing is not verifying.");
        return phase;
    }

    #end(ending: MobilePairingEnding, error: string | null): void {
        const phase = this.#phase;
        this.#token?.fill(0);
        this.#token = undefined;
        const verifying = phase.kind === "verifying" ? phase : undefined;
        if (verifying !== undefined) this.#forget(verifying);
        this.#phase = {
            kind: ending,
            device: phase.kind === "waiting" || phase.kind === "completed" ? null : phase.device,
            emoji: verifying?.secrets.emoji ?? null,
            mobileConfirmed: verifying?.mobileConfirmed ?? false,
            desktopConfirmed: verifying?.desktopConfirmed ?? false,
            error,
        };
        this.#changed();
    }

    #forget(phase: Extract<Phase, { kind: "verifying" }>): void {
        phase.secrets.confirmKey.fill(0);
        phase.secrets.deviceToken.fill(0);
    }

    #changed(): void {
        for (const wake of Array.from(this.#waiters)) wake();
    }
}
