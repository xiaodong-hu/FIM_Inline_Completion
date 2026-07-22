export interface AbortableRequest {
    readonly startedAt: number;
    abort(): void;
}

/**
 * Tracks background requests without allowing stale streams to grow without
 * bound. Entries are ordered by start time; when the limit is exceeded, the
 * oldest request is removed and aborted before its completion callback runs.
 */
export class BoundedRequestRegistry<T extends AbortableRequest> {
    private readonly entries = new Map<string, T>();
    private maxEntries: number;

    constructor(maxEntries: number) {
        this.maxEntries = this.normalizeLimit(maxEntries);
    }

    configure(maxEntries: number): void {
        this.maxEntries = this.normalizeLimit(maxEntries);
        this.evictOverflow();
    }

    get(key: string): T | undefined {
        return this.entries.get(key);
    }

    add(key: string, request: T): void {
        const previous = this.entries.get(key);
        if (previous === request) {
            return;
        }
        if (previous) {
            this.entries.delete(key);
            previous.abort();
        }

        this.entries.set(key, request);
        this.evictOverflow();
    }

    /** Delete only if key still refers to expected, protecting replacements. */
    delete(key: string, expected?: T): boolean {
        if (expected && this.entries.get(key) !== expected) {
            return false;
        }
        return this.entries.delete(key);
    }

    discardWhere(predicate: (request: T) => boolean): void {
        for (const [key, request] of this.entries) {
            if (predicate(request)) {
                this.entries.delete(key);
                request.abort();
            }
        }
    }

    clear(): void {
        const requests = [...this.entries.values()];
        this.entries.clear();
        for (const request of requests) {
            request.abort();
        }
    }

    get size(): number {
        return this.entries.size;
    }

    private evictOverflow(): void {
        while (this.entries.size > this.maxEntries) {
            let oldestKey: string | undefined;
            let oldestStartedAt = Number.POSITIVE_INFINITY;
            for (const [key, request] of this.entries) {
                if (request.startedAt < oldestStartedAt) {
                    oldestKey = key;
                    oldestStartedAt = request.startedAt;
                }
            }

            if (oldestKey === undefined) {
                return;
            }
            const oldest = this.entries.get(oldestKey);
            this.entries.delete(oldestKey);
            oldest?.abort();
        }
    }

    private normalizeLimit(value: number): number {
        return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
    }
}
