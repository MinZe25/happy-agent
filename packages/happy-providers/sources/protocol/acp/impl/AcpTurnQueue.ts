/**
 * An unbounded single-consumer queue. ACP notifications, bridged tool calls, and the prompt's own
 * completion all arrive on callbacks; the session's stream drains them here in arrival order.
 */
export class AcpTurnQueue<T> {
    readonly #items: T[] = [];
    #waiter: ((item: T) => void) | undefined;

    push(item: T): void {
        const waiter = this.#waiter;
        if (waiter !== undefined) {
            this.#waiter = undefined;
            waiter(item);
            return;
        }
        this.#items.push(item);
    }

    next(): Promise<T> {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve(item);
        return new Promise((resolve) => {
            this.#waiter = resolve;
        });
    }
}
