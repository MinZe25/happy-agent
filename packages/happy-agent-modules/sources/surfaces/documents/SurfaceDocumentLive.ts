import { createId } from "@paralleldrive/cuid2";
import type {
    SurfaceDocumentLiveFrame,
    SurfaceDocumentPresenceFrame,
    SurfaceDocumentUpdateFrame,
} from "@slopus/happy-agent-client";
import { SurfaceError } from "../SurfaceError.js";

export type DocumentFrameListener = (streamId: string, frame: SurfaceDocumentLiveFrame) => void;

/** One stream's subscription to one document, and the presence it relays there. */
type Subscriber = {
    readonly clientKey: string;
    revision: number;
    presence?: { awarenessClientId: number; update: string } | undefined;
    timer?: NodeJS.Timeout | undefined;
};

const MAX_DOCUMENTS_PER_STREAM = 32;
const MAX_STREAMS_PER_DOCUMENT = 64;
const PRESENCE_TIMEOUT_MS = 30_000;

/**
 * Which event streams follow which documents, and the presence each relays. Nothing here is
 * stored: it lives as long as the streams do, and a restart ends every stream.
 */
export class SurfaceDocumentLive {
    readonly #documents = new Map<string, Map<string, Subscriber>>();
    readonly #streams = new Map<string, Set<string>>();
    readonly #listeners = new Set<DocumentFrameListener>();

    onFrame(listener: DocumentFrameListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Subscribe a stream; repeating a subscription changes nothing. */
    subscribe(surfaceId: string, streamId: string): void {
        const subscribers = this.#documents.get(surfaceId) ?? new Map<string, Subscriber>();
        if (subscribers.has(streamId)) return;
        const documents = this.#streams.get(streamId) ?? new Set<string>();
        if (documents.size >= MAX_DOCUMENTS_PER_STREAM)
            throw new SurfaceError("conflict", "This connection already follows 32 documents.");
        if (subscribers.size >= MAX_STREAMS_PER_DOCUMENT)
            throw new SurfaceError("conflict", "This document already has 64 live connections.");
        subscribers.set(streamId, { clientKey: createId(), revision: 0 });
        this.#documents.set(surfaceId, subscribers);
        documents.add(surfaceId);
        this.#streams.set(streamId, documents);
    }

    isSubscribed(surfaceId: string, streamId: string): boolean {
        return this.#documents.get(surfaceId)?.has(streamId) === true;
    }

    /** Send a newly subscribed stream every other stream's active presence. */
    sendPresence(surfaceId: string, streamId: string): void {
        for (const [other, subscriber] of this.#documents.get(surfaceId) ?? [])
            if (other !== streamId && subscriber.presence !== undefined)
                this.#emit(streamId, {
                    type: "document.presence",
                    data: {
                        surfaceId,
                        clientKey: subscriber.clientKey,
                        revision: subscriber.revision,
                        active: true,
                        awarenessClientId: subscriber.presence.awarenessClientId,
                        update: subscriber.presence.update,
                    },
                });
    }

    unsubscribe(surfaceId: string, streamId: string): void {
        const subscribers = this.#documents.get(surfaceId);
        const subscriber = subscribers?.get(streamId);
        if (subscribers === undefined || subscriber === undefined) return;
        this.#deactivate(surfaceId, streamId, subscriber);
        subscribers.delete(streamId);
        if (subscribers.size === 0) this.#documents.delete(surfaceId);
        const documents = this.#streams.get(streamId);
        documents?.delete(surfaceId);
        if (documents?.size === 0) this.#streams.delete(streamId);
    }

    /** A closed stream leaves every document it followed. Unsubscribing edits the set, so copy it. */
    closeStream(streamId: string): void {
        for (const surfaceId of Array.from(this.#streams.get(streamId) ?? []))
            this.unsubscribe(surfaceId, streamId);
    }

    /**
     * Relay presence to the document's other streams. A stream that does not follow the document
     * relays nothing: a throttled presence send can land just after its window closed the document,
     * and it must not bring that presence back.
     */
    presence(surfaceId: string, streamId: string, awarenessClientId: number, update: string): void {
        const subscriber = this.#documents.get(surfaceId)?.get(streamId);
        if (subscriber === undefined) return;
        subscriber.presence = { awarenessClientId, update };
        subscriber.revision += 1;
        clearTimeout(subscriber.timer);
        subscriber.timer = setTimeout(
            () => this.#deactivate(surfaceId, streamId, subscriber),
            PRESENCE_TIMEOUT_MS,
        );
        subscriber.timer.unref();
        this.#broadcast(surfaceId, streamId, {
            surfaceId,
            clientKey: subscriber.clientKey,
            revision: subscriber.revision,
            active: true,
            awarenessClientId,
            update,
        });
    }

    /** Send a committed change to every stream following its document. */
    change(frame: SurfaceDocumentUpdateFrame): void {
        for (const streamId of this.#documents.get(frame.surfaceId)?.keys() ?? [])
            this.#emit(streamId, { type: "document.update", data: frame });
    }

    #deactivate(surfaceId: string, streamId: string, subscriber: Subscriber): void {
        clearTimeout(subscriber.timer);
        subscriber.timer = undefined;
        const presence = subscriber.presence;
        if (presence === undefined) return;
        subscriber.presence = undefined;
        subscriber.revision += 1;
        this.#broadcast(surfaceId, streamId, {
            surfaceId,
            clientKey: subscriber.clientKey,
            revision: subscriber.revision,
            active: false,
            awarenessClientId: presence.awarenessClientId,
        });
    }

    #broadcast(surfaceId: string, from: string, data: SurfaceDocumentPresenceFrame): void {
        for (const streamId of this.#documents.get(surfaceId)?.keys() ?? [])
            if (streamId !== from) this.#emit(streamId, { type: "document.presence", data });
    }

    #emit(streamId: string, frame: SurfaceDocumentLiveFrame): void {
        for (const listener of this.#listeners) listener(streamId, frame);
    }
}
