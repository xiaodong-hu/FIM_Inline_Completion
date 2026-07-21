import { createHash } from 'node:crypto';

export interface CompletionContext {
    documentUri: string;
    prefix: string;
    suffix: string;
    requestKey: string;
}

export interface CompletionCacheEntry {
    readonly id: string;
    readonly documentUri: string;
    readonly requestKey: string;
    readonly prefixLength: number;
    readonly prefixHash: string;
    readonly suffixHash: string;
    text: string;
    complete: boolean;
    createdAt: number;
    lastAccess: number;
}

export interface CompletionCacheMatch {
    entry: CompletionCacheEntry;
    /** Text inserted or typed since this completion was generated. */
    acceptedText: string;
    /** Still-valid completion text after acceptedText. */
    remainingText: string;
    kind: 'exact' | 'continuation';
}

export interface CompletionCacheOptions {
    ttlMs: number;
    maxEntries: number;
}

const DEFAULT_OPTIONS: CompletionCacheOptions = {
    ttlMs: 5 * 60_000,
    maxEntries: 64,
};

export function hashText(text: string): string {
    return createHash('sha256').update(text).digest('base64url');
}

/**
 * A collision-resistant key for an exact FIM request snapshot.
 *
 * This deliberately covers both sides of the cursor. An offset or document
 * version alone is not safe: edits can preserve either while changing the
 * actual model input.
 */
export function makeSnapshotKey(context: CompletionContext): string {
    const digest = createHash('sha256');
    digest.update(context.documentUri);
    digest.update('\0');
    digest.update(context.requestKey);
    digest.update('\0');
    digest.update(context.prefix);
    digest.update('\0');
    digest.update(context.suffix);
    return digest.digest('base64url');
}

/**
 * In-memory completion cache with content-validated continuation matching.
 *
 * Prefix/suffix bodies are represented by hashes in entries, so keeping many
 * completions does not retain many copies of a large document. A continuation
 * is reusable only when:
 *   - the suffix is byte-for-byte identical;
 *   - the old prefix is still an exact prefix of the current prefix; and
 *   - newly inserted text is an exact prefix of the generated completion.
 */
export class CompletionCache {
    private readonly entries = new Map<string, CompletionCacheEntry>();
    private options: CompletionCacheOptions;

    constructor(options: Partial<CompletionCacheOptions> = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    configure(options: Partial<CompletionCacheOptions>): void {
        this.options = { ...this.options, ...options };
        this.prune();
    }

    create(context: CompletionContext, now = Date.now()): CompletionCacheEntry {
        const id = makeSnapshotKey(context);
        const previous = this.entries.get(id);
        if (previous) {
            previous.lastAccess = now;
            return previous;
        }

        const entry: CompletionCacheEntry = {
            id,
            documentUri: context.documentUri,
            requestKey: context.requestKey,
            prefixLength: context.prefix.length,
            prefixHash: hashText(context.prefix),
            suffixHash: hashText(context.suffix),
            text: '',
            complete: false,
            createdAt: now,
            lastAccess: now,
        };
        this.entries.set(id, entry);
        this.prune(now);
        return entry;
    }

    delete(entryOrId: CompletionCacheEntry | string): void {
        this.entries.delete(typeof entryOrId === 'string' ? entryOrId : entryOrId.id);
    }

    clear(): void {
        this.entries.clear();
    }

    find(context: CompletionContext, now = Date.now()): CompletionCacheMatch | undefined {
        this.prune(now);
        const suffixHash = hashText(context.suffix);
        const candidates = [...this.entries.values()]
            .filter(entry => (
                entry.documentUri === context.documentUri &&
                entry.requestKey === context.requestKey &&
                entry.suffixHash === suffixHash &&
                entry.prefixLength <= context.prefix.length &&
                (entry.text.length > 0 || entry.complete)
            ))
            .sort((a, b) => (
                b.prefixLength - a.prefixLength ||
                b.createdAt - a.createdAt
            ));

        for (const entry of candidates) {

            const originalPrefix = context.prefix.slice(0, entry.prefixLength);
            if (hashText(originalPrefix) !== entry.prefixHash) {
                continue;
            }

            const acceptedText = context.prefix.slice(entry.prefixLength);
            // VS Code may normalize inserted LF text to a CRLF document. Treat
            // that representation change as the same accepted completion.
            const comparableAcceptedText = acceptedText.replace(/\r\n/g, '\n');
            if (!entry.text.startsWith(comparableAcceptedText)) {
                continue;
            }

            entry.lastAccess = now;
            return {
                entry,
                acceptedText,
                remainingText: entry.text.slice(comparableAcceptedText.length),
                kind: acceptedText.length === 0 ? 'exact' : 'continuation',
            };
        }
        return undefined;
    }

    get size(): number {
        return this.entries.size;
    }

    private prune(now = Date.now()): void {
        for (const [id, entry] of this.entries) {
            if (now - entry.lastAccess > this.options.ttlMs) {
                this.entries.delete(id);
            }
        }

        if (this.entries.size <= this.options.maxEntries) {
            return;
        }

        const oldestFirst = [...this.entries.values()]
            .sort((a, b) => a.lastAccess - b.lastAccess);
        const removeCount = this.entries.size - this.options.maxEntries;
        for (let index = 0; index < removeCount; index++) {
            const entry = oldestFirst[index];
            if (entry) {
                this.entries.delete(entry.id);
            }
        }
    }
}
