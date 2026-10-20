/** An async iterable fed by `push`, for the SDK's streaming input. Ends once closed. */
export class AsyncInputQueue<T> implements AsyncIterable<T> {
    readonly #items: T[] = [];
    #waiter: ((result: IteratorResult<T>) => void) | undefined;
    #closed = false;

    push(item: T): void {
        if (this.#closed) return;
        const waiter = this.#waiter;
        if (waiter === undefined) {
            this.#items.push(item);
            return;
        }
        this.#waiter = undefined;
        waiter({ value: item, done: false });
    }

    close(): void {
        this.#closed = true;
        this.#waiter?.({ value: undefined, done: true });
        this.#waiter = undefined;
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
            next: () => {
                const item = this.#items.shift();
                if (item !== undefined) return Promise.resolve({ value: item, done: false });
                if (this.#closed) return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve) => {
                    this.#waiter = resolve;
                });
            },
        };
    }
}
