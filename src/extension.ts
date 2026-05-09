import * as vscode from 'vscode';

const SECRET_KEY = 'FIM.apiKey';
const output = vscode.window.createOutputChannel('FIM');

/* ------------------------------------------------------------------ */
/*  Types & Config                                                     */
/* ------------------------------------------------------------------ */

interface ExtensionConfig {
    enabled: boolean;
    provider: 'deepseek' | 'custom';
    baseUrl: string;
    completionsPath: string;
    model: string;
    apiKeyEnvVar: string;
    maxTokens: number;
    temperature: number;
    topP: number;
    prefixChars: number;
    suffixChars: number;
    withSuffix: boolean;
    minPrefixChars: number;
    requestTimeoutMs: number;
    debounceMs: number;
    stop: string[];
    logRequests: boolean;
    streamEnabled: boolean;
    streamTokens: number;
    streamCacheTtlMs: number;
}

/* ------------------------------------------------------------------ */
/*  Stream Cache – progressive multi-chunk completion                  */
/* ------------------------------------------------------------------ */

interface StreamCacheEntry {
    /** The full text accumulated so far (or complete). */
    fullText: string;
    /** How many characters were already returned to VS Code. */
    returnedChars: number;
    /** Whether the upstream stream has finished. */
    isComplete: boolean;
    /** Timestamp of last activity (for TTL eviction). */
    lastAccess: number;
    /** Resolves when the stream finishes (or aborts). Used by waiters. */
    donePromise: Promise<void>;
    /** Allow external code to signal done. */
    resolveDone: () => void;
}

const streamCache = new Map<string, StreamCacheEntry>();

/** Periodically evict stale cache entries. */
setInterval(() => {
    const now = Date.now();
    const cfg = getConfig();
    for (const [key, entry] of streamCache) {
        if (now - entry.lastAccess > cfg.streamCacheTtlMs) {
            streamCache.delete(key);
        }
    }
}, 10_000);

/**
 * Build a cache key that is stable enough to survive small edits.
 * We key on document + offset + model + a "fuzzy" hash of the last 256 chars
 * of the prefix (the most relevant context for FIM).  This way when the user
 * types a few characters the cache can still serve the continuation.
 */
function makeCacheKey(
    doc: vscode.TextDocument,
    offset: number,
    prefix: string,
    model: string,
): string {
    // Only the tail of the prefix matters for FIM – the model mainly looks at
    // nearby context.  Hashing the last 256 chars keeps the key stable across
    // small edits while still invalidating when the immediate context changes.
    const tail = prefix.length > 256 ? prefix.slice(prefix.length - 256) : prefix;
    const tailHash = simpleHash(tail);
    return `${doc.uri.toString()}|${offset}|${tailHash}|${model}`;
}

/**
 * Search the stream cache for entries at *nearby* offsets (within ±16 chars).
 * When the user types a few characters we can often reuse a stream that was
 * started for a slightly earlier cursor position.
 */
function findNearbyCacheEntry(
    doc: vscode.TextDocument,
    offset: number,
    prefix: string,
    model: string,
): StreamCacheEntry | undefined {
    // First try exact match.
    const exactKey = makeCacheKey(doc, offset, prefix, model);
    const exact = streamCache.get(exactKey);
    if (exact) return exact;

    // Then search nearby offsets (look-back first – user usually types forward).
    for (let delta = -1; delta >= -16; delta--) {
        const nearbyOffset = offset + delta;
        if (nearbyOffset < 0) continue;
        const nearbyKey = makeCacheKey(doc, nearbyOffset, prefix, model);
        const entry = streamCache.get(nearbyKey);
        if (entry && entry.fullText.length > entry.returnedChars) {
            // Found a nearby entry with unconsumed text.
            // Re-key it to the current offset so subsequent lookups hit directly.
            streamCache.delete(nearbyKey);
            entry.lastAccess = Date.now();
            streamCache.set(exactKey, entry);
            return entry;
        }
    }

    return undefined;
}

function simpleHash(s: string): number {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
        const ch = s.charCodeAt(i);
        hash = ((hash << 5) - hash + ch) | 0;
    }
    return hash;
}

interface CompletionChoice {
    text?: string;
}

function getConfig(): ExtensionConfig {
    const cfg = vscode.workspace.getConfiguration('FIM');
    return {
        enabled: cfg.get<boolean>('enabled', true),
        provider: cfg.get<'deepseek' | 'custom'>('provider', 'deepseek'),
        baseUrl: cfg.get<string>('baseUrl', 'https://api.deepseek.com/beta'),
        completionsPath: cfg.get<string>('completionsPath', '/completions'),
        model: cfg.get<string>('model', 'deepseek-v4-flash'),
        apiKeyEnvVar: cfg.get<string>('apiKeyEnvVar', 'DEEPSEEK_API_KEY'),
        maxTokens: cfg.get<number>('maxTokens', 64),
        temperature: cfg.get<number>('temperature', 0.0),
        topP: cfg.get<number>('topP', 0.9),
        prefixChars: cfg.get<number>('prefixChars', 12000),
        suffixChars: cfg.get<number>('suffixChars', 8000),
        withSuffix: cfg.get<boolean>('withSuffix', true),
        minPrefixChars: cfg.get<number>('minPrefixChars', 4),
        requestTimeoutMs: cfg.get<number>('requestTimeoutMs', 6000),
        debounceMs: cfg.get<number>('debounceMs', 200),
        stop: cfg.get<string[]>('stop', []),
        logRequests: cfg.get<boolean>('logRequests', false),
        streamEnabled: cfg.get<boolean>('streamEnabled', true),
        streamTokens: cfg.get<number>('streamTokens', 5),
        streamCacheTtlMs: cfg.get<number>('streamCacheTtlMs', 30000),
    };
}

function joinUrl(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function sleep(ms: number, token: vscode.CancellationToken): Promise<void> {
    if (ms <= 0) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, ms);
        const disposable = token.onCancellationRequested(() => {
            clearTimeout(timeout);
            disposable.dispose();
            reject(new vscode.CancellationError());
        });
    });
}

async function getApiKey(context: vscode.ExtensionContext, cfg: ExtensionConfig): Promise<string | undefined> {
    const fromSecret = await context.secrets.get(SECRET_KEY);
    if (fromSecret && fromSecret.trim().length > 0) {
        return fromSecret.trim();
    }

    const fromEnv = process.env[cfg.apiKeyEnvVar];
    if (fromEnv && fromEnv.trim().length > 0) {
        return fromEnv.trim();
    }

    return undefined;
}

function getPrefixSuffix(
    document: vscode.TextDocument,
    position: vscode.Position,
    cfg: ExtensionConfig,
): { prefix: string; suffix: string; offset: number } {
    const offset = document.offsetAt(position);

    const prefixStartOffset = Math.max(0, offset - cfg.prefixChars);
    const suffixEndOffset = Math.min(
        document.offsetAt(document.lineAt(document.lineCount - 1).range.end),
        offset + cfg.suffixChars,
    );

    const prefixStartPos = document.positionAt(prefixStartOffset);
    const suffixEndPos = document.positionAt(suffixEndOffset);

    const prefix = document.getText(new vscode.Range(prefixStartPos, position));
    const suffix = document.getText(new vscode.Range(position, suffixEndPos));

    return { prefix, suffix, offset };
}

function cleanupCompletion(text: string): string {
    let t = text.replace(/\r\n/g, '\n');

    // Avoid huge accidental blocks if the backend ignores max_tokens or emits Markdown fences.
    t = t.replace(/^```[a-zA-Z0-9_+-]*\n/, '');
    t = t.replace(/\n```\s*$/, '');

    // VS Code inline completions should not insert a terminal NUL-like artifact.
    t = t.replace(/\u0000/g, '');

    return t;
}



/* ------------------------------------------------------------------ */
/*  Streaming FIM request with early-return for progressive display    */
/* ------------------------------------------------------------------ */

/**
 * Start a streaming FIM request.
 *
 * When `cfg.streamEnabled` is true:
 *   1. The function returns as soon as `cfg.streamTokens` tokens have been
 *      collected, giving VS Code an *instant* inline completion.
 *   2. The remainder of the stream is read in the background and stored in
 *      `streamCache`.  On the very next keystroke the provider will serve the
 *      next chunk from cache – **no API call needed**.
 *
 * Returns:
 *   - `text`: the text to show right now (may be partial)
 *   - `isComplete`: whether the full stream has been consumed
 *   - The cache entry is populated / updated for subsequent calls.
 */
async function requestFimStream(
    apiKey: string,
    cfg: ExtensionConfig,
    prefix: string,
    suffix: string,
    cacheKey: string,
    token: vscode.CancellationToken,
): Promise<{ text: string; isComplete: boolean } | undefined> {
    const url = joinUrl(cfg.baseUrl, cfg.completionsPath);
    const payload: Record<string, unknown> = {
        model: cfg.model,
        prompt: prefix,
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
        top_p: cfg.topP,
        stream: true,
    };

    if (cfg.withSuffix) {
        payload.suffix = suffix;
    }

    if (cfg.stop.length > 0) {
        (payload as any).stop = cfg.stop;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
    const cancelDisposable = token.onCancellationRequested(() => controller.abort());

    // Create the cache entry *before* we start so concurrent keystrokes see it.
    let resolveDone: () => void;
    const donePromise = new Promise<void>(r => { resolveDone = r; });

    const entry: StreamCacheEntry = {
        fullText: '',
        returnedChars: 0,
        isComplete: false,
        lastAccess: Date.now(),
        donePromise,
        resolveDone: resolveDone!,
    };
    streamCache.set(cacheKey, entry);

    // We'll collect enough characters to approximate cfg.streamTokens tokens.
    // A rough heuristic: avg token ≈ 4 chars for code.
    const streamCharTarget = cfg.streamEnabled
        ? cfg.streamTokens * 4
        : Number.MAX_SAFE_INTEGER;

    try {
        const start = Date.now();
        if (cfg.logRequests) {
            output.appendLine(
                `[req] model=${cfg.model} prefix_len=${prefix.length} suffix_len=${suffix.length} max_tokens=${cfg.maxTokens} stream_tokens=${cfg.streamTokens}`,
            );
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        if (!response.ok) {
            const errText = await response.text();
            output.appendLine(`[http ${response.status}] ${errText}`);
            streamCache.delete(cacheKey);
            return undefined;
        }

        const reader = response.body?.getReader();
        if (!reader) {
            streamCache.delete(cacheKey);
            return undefined;
        }

        const decoder = new TextDecoder();
        let firstToken = true;
        let earlyResolved = false;

        // ---- inner read loop -------------------------------------------------
        while (true) {
            if (token.isCancellationRequested) {
                reader.cancel();
                streamCache.delete(cacheKey);
                return undefined;
            }

            const { done, value } = await reader.read();
            if (done) {
                // Stream finished naturally.
                entry.isComplete = true;
                entry.lastAccess = Date.now();
                entry.resolveDone();
                break;
            }

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    entry.isComplete = true;
                    entry.lastAccess = Date.now();
                    entry.resolveDone();
                    break;
                }

                try {
                    const parsed = JSON.parse(data);
                    const text = parsed.choices?.[0]?.text;
                    if (text) {
                        if (firstToken) {
                            firstToken = false;
                            const ttfb = Date.now() - start;
                            if (cfg.logRequests) {
                                output.appendLine(`[stream] TTFB: ${ttfb}ms`);
                            }
                        }
                        entry.fullText += text;
                        entry.lastAccess = Date.now();
                    }
                } catch { /* ignore malformed SSE lines */ }
            }

            // ---- early return: we have enough characters for the first chunk ---
            if (
                !earlyResolved &&
                cfg.streamEnabled &&
                entry.fullText.length >= streamCharTarget
            ) {
                earlyResolved = true;
                const cleaned = cleanupCompletion(entry.fullText);
                entry.fullText = cleaned;        // keep cache consistent with returnedChars
                entry.returnedChars = cleaned.length;

                // Return the first chunk NOW. The rest continues in background.
                const elapsed = Date.now() - start;
                if (cfg.logRequests) {
                    output.appendLine(
                        `[stream] early-return after ${elapsed}ms, ${cleaned.length} chars (target ~${cfg.streamTokens} tokens)`,
                    );
                }

                // Don't break – keep reading in background.
                // We return this partial result but the loop continues.
                const partialResult = cleaned.trim().length > 0 ? cleaned : entry.fullText;

                // Continue the loop in the background, return early.
                // We use a microtask to keep the reader alive after returning.
                (async () => {
                    try {
                        await continueReadingInBackground(
                            reader, decoder, entry, cfg, token, start
                        );
                    } catch { /* reader already closed or cancelled */ }
                })();

                return {
                    text: partialResult,
                    isComplete: false,
                };
            }
        }

        // ---- stream ended (or early-return not enabled) ----------------------
        const total = Date.now() - start;
        if (cfg.logRequests) {
            output.appendLine(
                `[req] completed in ${total}ms, response length: ${entry.fullText.length} chars`,
            );
        }

        if (token.isCancellationRequested) {
            streamCache.delete(cacheKey);
            return undefined;
        }

        const cleaned = cleanupCompletion(entry.fullText);
        entry.fullText = cleaned;
        entry.returnedChars = cleaned.length;
        entry.isComplete = true;
        entry.resolveDone();

        return cleaned.trim().length > 0
            ? { text: cleaned, isComplete: true }
            : undefined;
    } catch (err) {
        if (!token.isCancellationRequested) {
            output.appendLine(`[err] ${String(err)}`);
        }
        streamCache.delete(cacheKey);
        return undefined;
    } finally {
        clearTimeout(timeout);
        cancelDisposable.dispose();
    }
}

/**
 * Continue reading the SSE stream in the background after the early return.
 * Updates the cache entry in-place so the next `provideInlineCompletionItems`
 * call can serve the continuation from cache.
 */
async function continueReadingInBackground(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    entry: StreamCacheEntry,
    cfg: ExtensionConfig,
    token: vscode.CancellationToken,
    start: number,
): Promise<void> {
    try {
        while (true) {
            if (token.isCancellationRequested) {
                reader.cancel();
                break;
            }

            const { done, value } = await reader.read();
            if (done) {
                entry.isComplete = true;
                entry.lastAccess = Date.now();
                entry.resolveDone();
                break;
            }

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    entry.isComplete = true;
                    entry.lastAccess = Date.now();
                    entry.resolveDone();
                    return;
                }

                try {
                    const parsed = JSON.parse(data);
                    const text = parsed.choices?.[0]?.text;
                    if (text) {
                        entry.fullText += text;
                        entry.lastAccess = Date.now();
                    }
                } catch { /* ignore */ }
            }
        }
    } catch {
        // Reader cancelled or network error – cache what we have.
        entry.isComplete = true;
        entry.resolveDone();
    } finally {
        if (cfg.logRequests) {
            const total = Date.now() - start;
            output.appendLine(
                `[stream-bg] finished in ${total}ms, total chars: ${entry.fullText.length}`,
            );
        }
    }
}

/** Legacy wrapper used by the test command. */
async function requestFim(
    apiKey: string,
    cfg: ExtensionConfig,
    prefix: string,
    suffix: string,
    token: vscode.CancellationToken,
): Promise<string | undefined> {
    const cacheKey = `test|${Date.now()}|${Math.random()}`;
    // Force full streaming (no early return) for test requests.
    const testCfg = { ...cfg, streamEnabled: false };
    const result = await requestFimStream(apiKey, testCfg, prefix, suffix, cacheKey, token);
    return result?.text;
}


/* ------------------------------------------------------------------ */
/*  Inline Completion Provider                                         */
/* ------------------------------------------------------------------ */

function buildProvider(context: vscode.ExtensionContext): vscode.InlineCompletionItemProvider {
    let warnedMissingKey = false;

    return {
        async provideInlineCompletionItems(document, position, _inlineContext, token) {
            const cfg = getConfig();
            if (!cfg.enabled) {
                return undefined;
            }

            if (
                document.uri.scheme !== 'file' &&
                document.uri.scheme !== 'untitled' &&
                document.uri.scheme !== 'vscode-notebook-cell'
            ) {
                return undefined;
            }

            await sleep(cfg.debounceMs, token);
            if (token.isCancellationRequested) {
                return undefined;
            }

            const apiKey = await getApiKey(context, cfg);
            if (!apiKey) {
                if (!warnedMissingKey) {
                    warnedMissingKey = true;
                    vscode.window.showWarningMessage(
                        `FIM: no API key. Run "FIM: Set API Key" or set ${cfg.apiKeyEnvVar}.`,
                    );
                }
                return undefined;
            }

            const { prefix, suffix, offset } = getPrefixSuffix(document, position, cfg);
            if (prefix.trimEnd().length < cfg.minPrefixChars) {
                return undefined;
            }

            // ── cache-first strategy ──────────────────────────────────────
            const cacheKey = makeCacheKey(document, offset, prefix, cfg.model);

            // 1) Check if we have a cached stream continuation (exact or nearby offset).
            const cached = findNearbyCacheEntry(document, offset, prefix, cfg.model);
            if (cached && cached.returnedChars < cached.fullText.length) {
                // There is new text the user hasn't seen yet – serve it instantly!
                cached.lastAccess = Date.now();
                const available = cached.fullText.slice(cached.returnedChars);

                // Only serve a chunk of ~streamTokens chars to keep the
                // token-by-token feel (don't dump all 64 tokens at once).
                const chunkSize = cfg.streamTokens * 4;
                const newText = available.length > chunkSize
                    ? available.slice(0, chunkSize)
                    : available;
                cached.returnedChars += newText.length;

                const cleaned = cleanupCompletion(newText);
                if (cleaned.trim().length > 0) {
                    if (cfg.logRequests) {
                        output.appendLine(
                            `[cache-hit] serving ${cleaned.length} cached chars (total buffered: ${cached.fullText.length - cached.returnedChars})`,
                        );
                    }
                    return new vscode.InlineCompletionList([
                        new vscode.InlineCompletionItem(
                            cleaned,
                            new vscode.Range(position, position),
                        ),
                    ]);
                }
            }

            // 2) If a stream for this position is already in-flight, wait for
            //    it to produce enough data instead of starting a duplicate.
            const inflight = streamCache.get(cacheKey);
            if (inflight && !inflight.isComplete && inflight.fullText.length === 0) {
                // Wait for at least streamTokens worth of characters.
                const streamCharTarget = cfg.streamTokens * 4;
                const waitStart = Date.now();
                while (
                    inflight.fullText.length < streamCharTarget &&
                    !inflight.isComplete &&
                    Date.now() - waitStart < 2000 // safety timeout
                ) {
                    await sleep(50, token);
                    if (token.isCancellationRequested) return undefined;
                }

                if (inflight.fullText.length > 0) {
                    const toReturn = inflight.fullText.slice(inflight.returnedChars);
                    inflight.returnedChars = inflight.fullText.length;
                    const cleaned = cleanupCompletion(toReturn);
                    if (cleaned.trim().length > 0) {
                        return new vscode.InlineCompletionList([
                            new vscode.InlineCompletionItem(
                                cleaned,
                                new vscode.Range(position, position),
                            ),
                        ]);
                    }
                }
            }

            // 3) No usable cache – start a fresh streaming request.
            const result = await requestFimStream(
                apiKey,
                cfg,
                prefix,
                suffix,
                cacheKey,
                token,
            );

            if (!result || token.isCancellationRequested) {
                return undefined;
            }

            return new vscode.InlineCompletionList([
                new vscode.InlineCompletionItem(
                    result.text,
                    new vscode.Range(position, position),
                ),
            ]);
        },
    };
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
    const key = await vscode.window.showInputBox({
        title: 'FIM API Key',
        prompt: 'Enter the API key. It will be stored in VS Code SecretStorage.',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'sk-...',
    });

    if (!key) {
        return;
    }

    await context.secrets.store(SECRET_KEY, key.trim());
    vscode.window.showInformationMessage('FIM API key saved.');
}

async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage('FIM API key cleared.');
}

async function testRequest(context: vscode.ExtensionContext): Promise<void> {
    const cfg = getConfig();
    const apiKey = await getApiKey(context, cfg);
    if (!apiKey) {
        vscode.window.showWarningMessage(`FIM: no API key. Run "FIM: Set API Key" first.`);
        return;
    }

    const source = new vscode.CancellationTokenSource();
    const text = await requestFim(
        apiKey,
        cfg,
        'def fib(a):\n    ',
        '\n    return fib(a-1) + fib(a-2)',
        source.token,
    );

    if (text) {
        output.appendLine(`[test completion]\n${text}`);
        output.show(true);
        vscode.window.showInformationMessage('FIM test succeeded. See the FIM output channel.');
    } else {
        output.show(true);
        vscode.window.showWarningMessage('FIM test failed. See the FIM output channel.');
    }
}

async function toggleEnabled(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('FIM');
    const current = cfg.get<boolean>('enabled', true);
    await cfg.update('enabled', !current, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`FIM inline completion ${!current ? 'enabled' : 'disabled'}.`);
}

export function activate(context: vscode.ExtensionContext): void {
    output.appendLine('FIM extension activated.');

    context.subscriptions.push(output);

    context.subscriptions.push(
        vscode.commands.registerCommand('FIM.setApiKey', () => setApiKey(context)),
        vscode.commands.registerCommand('FIM.clearApiKey', () => clearApiKey(context)),
        vscode.commands.registerCommand('FIM.testRequest', () => testRequest(context)),
        vscode.commands.registerCommand('FIM.toggle', () => toggleEnabled()),
    );

    const provider = buildProvider(context);
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(
            [
                { scheme: 'file', pattern: '**' },
                { scheme: 'untitled', pattern: '**' },
                { scheme: 'vscode-notebook-cell', pattern: '**' },
            ],
            provider,
        ),
    );
}

export function deactivate(): void {
    // Nothing to clean up beyond disposables registered in activate().
}
