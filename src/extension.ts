import * as vscode from 'vscode';
import * as path from 'path';

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
    withSuffix: boolean;
    requestTimeoutMs: number;
    debounceMs: number;
    stop: string[];
    logRequests: boolean;
    streamEnabled: boolean;
    streamTokens: number;
    streamCacheTtlMs: number;
    /** Whether to include cross-file project context (preamble). */
    preambleEnabled: boolean;
    /** Maximum number of other project files to include in the preamble. */
    preambleMaxFiles: number;
    /** Maximum total characters for the preamble (soft cap). */
    preambleMaxChars: number;
    /** Glob patterns for files to include in the preamble. */
    preambleIncludePatterns: string[];
    /** Glob patterns for files to exclude from the preamble. */
    preambleExcludePatterns: string[];
    /** Minimum prefix chars before requesting a completion. */
    minPrefixChars: number;
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
    /** Resolves when the stream finishes (or aborts). */
    donePromise: Promise<void>;
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
 * Build a simple, stable cache key.
 *
 * With full-file context, the prompt/suffix pair is identical for a given
 * (document, offset) regardless of what was typed before — only the cursor
 * position matters.  No hash needed.
 */
function makeCacheKey(
    doc: vscode.TextDocument,
    offset: number,
    model: string,
): string {
    return `${doc.uri.toString()}|${offset}|${model}`;
}

/**
 * Search the stream cache for entries at nearby offsets (±16 chars).
 * When the user types a few characters we can often reuse a stream started
 * for a slightly earlier cursor position.
 */
function findNearbyCacheEntry(
    doc: vscode.TextDocument,
    offset: number,
    model: string,
): StreamCacheEntry | undefined {
    // First try exact match.
    const exactKey = makeCacheKey(doc, offset, model);
    const exact = streamCache.get(exactKey);
    if (exact) {
        return exact;
    }

    // Search nearby offsets (look-back first — user usually types forward).
    for (let delta = -1; delta >= -16; delta--) {
        const nearbyOffset = offset + delta;
        if (nearbyOffset < 0) {
            continue;
        }
        const nearbyKey = makeCacheKey(doc, nearbyOffset, model);
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

/* ------------------------------------------------------------------ */
/*  Project Preamble – cross-file context for KV-cache-friendly FIM    */
/* ------------------------------------------------------------------ */

/**
 * Cached preamble: other project files concatenated in a deterministic order.
 * This text is prepended to *every* FIM prompt so that DeepSeek's server-side
 * KV cache can reuse the attention states for the preamble portion across all
 * keystrokes in the same file.
 */
interface PreambleCache {
    /** Combined text: "### FILE: <relpath> ###\n<content>\n" per file. */
    text: string;
    /** Total character count. */
    totalChars: number;
    /** Number of files included. */
    fileCount: number;
    /** When this cache was built (Date.now()). */
    builtAt: number;
}

let preambleCache: PreambleCache | undefined;
let preambleBuildLock = false;
/** File-system watcher – invalidates preamble on changes. */
let preambleWatcher: vscode.FileSystemWatcher | undefined;

/** Source-code-ish extensions we consider for the preamble. */
const SOURCE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.pyi', '.pyx',
    '.rs', '.go', '.java', '.kt', '.kts', '.scala',
    '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh',
    '.cs', '.rb', '.php', '.swift', '.mm', '.m',
    '.sql', '.graphql', '.gql',
    '.json', '.yaml', '.yml', '.toml', '.xml',
    '.md', '.markdown', '.rst', '.txt',
    '.sh', '.bash', '.zsh', '.fish',
    '.html', '.css', '.scss', '.less',
    '.vue', '.svelte', '.astro',
    '.tf', '.hcl',
    '.dart', '.lua', '.r', '.jl',
    '.proto', '.thrift',
]);

/**
 * Build (or return cached) the project preamble.
 *
 * The preamble is a concatenation of all relevant project source files
 * (filtered by VS Code's own exclude settings, which respect .gitignore).
 * Files are sorted alphabetically by relative path for deterministic ordering.
 *
 * The CURRENT file (the one being edited) is EXCLUDED from the preamble —
 * its content is sent as the dynamic prefix/suffix instead.
 */
async function getPreamble(
    currentDocUri: vscode.Uri,
    cfg: ExtensionConfig,
): Promise<string> {
    if (!cfg.preambleEnabled) {
        return '';
    }

    // Return cached preamble if fresh (< 30 s).
    if (preambleCache && Date.now() - preambleCache.builtAt < 30_000) {
        return preambleCache.text;
    }

    // Prevent concurrent builds.
    if (preambleBuildLock) {
        for (let i = 0; i < 20; i++) {
            await sleep(100, new vscode.CancellationTokenSource().token);
            if (preambleCache && Date.now() - preambleCache.builtAt < 30_000) {
                return preambleCache.text;
            }
        }
        return preambleCache?.text ?? '';
    }

    preambleBuildLock = true;
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            preambleCache = { text: '', totalChars: 0, fileCount: 0, builtAt: Date.now() };
            return '';
        }

        // Collect files using VS Code's workspace.findFiles, which respects
        // .gitignore and files.exclude settings when exclude is null.
        const includePattern = cfg.preambleIncludePatterns.length > 0
            ? `{${cfg.preambleIncludePatterns.join(',')}}`
            : '**/*';
        const excludePattern = cfg.preambleExcludePatterns.length > 0
            ? `{${cfg.preambleExcludePatterns.join(',')}}`
            : null;

        const uris = await vscode.workspace.findFiles(
            includePattern, excludePattern, cfg.preambleMaxFiles + 50,
        );

        // Filter: only source-like extensions, non-binary, not the current file.
        const currentFsPath = currentDocUri.fsPath;
        const candidateUris = uris.filter(uri => {
            if (uri.fsPath === currentFsPath) {
                return false;
            }
            const ext = path.extname(uri.fsPath).toLowerCase();
            return SOURCE_EXTENSIONS.has(ext);
        });

        // Sort deterministically by workspace-relative path.
        const root = workspaceFolders[0]!.uri.fsPath;
        candidateUris.sort((a, b) => {
            const ra = path.relative(root, a.fsPath);
            const rb = path.relative(root, b.fsPath);
            return ra.localeCompare(rb);
        });

        // Read files and build preamble.
        const parts: string[] = [];
        let totalChars = 0;
        let fileCount = 0;

        for (const uri of candidateUris) {
            if (fileCount >= cfg.preambleMaxFiles) {
                break;
            }
            if (totalChars >= cfg.preambleMaxChars) {
                break;
            }

            try {
                const contentBytes = await vscode.workspace.fs.readFile(uri);
                const content = new TextDecoder().decode(contentBytes);

                // Skip obviously binary content.
                if (content.includes('\x00')) {
                    continue;
                }

                const relPath = path.relative(root, uri.fsPath);
                const header = `### FILE: ${relPath} ###\n`;
                const block = header + content + '\n';

                // Soft cap: allow the last file to push us a bit over.
                if (totalChars > 0 && totalChars + block.length > cfg.preambleMaxChars * 1.2) {
                    break;
                }

                parts.push(block);
                totalChars += block.length;
                fileCount++;
            } catch {
                // Skip unreadable files.
            }
        }

        const text = parts.join('');
        preambleCache = { text, totalChars, fileCount, builtAt: Date.now() };

        if (cfg.logRequests) {
            output.appendLine(
                `[preamble] built: ${fileCount} files, ${totalChars} chars`,
            );
        }

        return text;
    } finally {
        preambleBuildLock = false;
    }
}

/** Invalidate the preamble cache (called by file watcher). */
function invalidatePreamble(): void {
    preambleCache = undefined;
}

/** Set up a file-system watcher to invalidate preamble on project changes. */
function setupPreambleWatcher(context: vscode.ExtensionContext): void {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return;
    }

    // Watch for file creates/deletes at the workspace root.
    const rootFolder = workspaceFolders[0]!;
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(rootFolder, '**/*'),
        false, // ignoreCreateEvents
        false, // ignoreChangeEvents
        false, // ignoreDeleteEvents
    );

    watcher.onDidCreate(() => invalidatePreamble());
    watcher.onDidDelete(() => invalidatePreamble());
    // We don't watch content changes (too noisy) — the 30 s TTL handles that.

    context.subscriptions.push(watcher);
    preambleWatcher = watcher;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getConfig(): ExtensionConfig {
    const cfg = vscode.workspace.getConfiguration('FIM');
    return {
        enabled: cfg.get<boolean>('enabled', true),
        provider: cfg.get<'deepseek' | 'custom'>('provider', 'deepseek'),
        baseUrl: cfg.get<string>('baseUrl', 'https://api.deepseek.com/beta'),
        completionsPath: cfg.get<string>('completionsPath', '/completions'),
        model: cfg.get<string>('model', 'deepseek-v4-pro'),
        apiKeyEnvVar: cfg.get<string>('apiKeyEnvVar', 'DEEPSEEK_API_KEY'),
        maxTokens: cfg.get<number>('maxTokens', 256),
        temperature: cfg.get<number>('temperature', 0.0),
        topP: cfg.get<number>('topP', 0.9),
        withSuffix: cfg.get<boolean>('withSuffix', true),
        requestTimeoutMs: cfg.get<number>('requestTimeoutMs', 10000),
        debounceMs: cfg.get<number>('debounceMs', 200),
        stop: cfg.get<string[]>('stop', []),
        logRequests: cfg.get<boolean>('logRequests', false),
        streamEnabled: cfg.get<boolean>('streamEnabled', true),
        streamTokens: cfg.get<number>('streamTokens', 5),
        streamCacheTtlMs: cfg.get<number>('streamCacheTtlMs', 30000),
        preambleEnabled: cfg.get<boolean>('preambleEnabled', true),
        preambleMaxFiles: cfg.get<number>('preambleMaxFiles', 100),
        preambleMaxChars: cfg.get<number>('preambleMaxChars', 500_000),
        preambleIncludePatterns: cfg.get<string[]>('preambleIncludePatterns', []),
        preambleExcludePatterns: cfg.get<string[]>('preambleExcludePatterns', [
            '**/node_modules/**',
            '**/.git/**',
            '**/dist/**',
            '**/build/**',
            '**/out/**',
            '**/.next/**',
            '**/target/**',
            '**/__pycache__/**',
            '**/*.min.*',
            '**/package-lock.json',
            '**/yarn.lock',
            '**/pnpm-lock.yaml',
            '**/Cargo.lock',
        ]),
        minPrefixChars: cfg.get<number>('minPrefixChars', 4),
    };
}

function joinUrl(baseUrl: string, pathStr: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/${pathStr.replace(/^\/+/, '')}`;
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

async function getApiKey(
    context: vscode.ExtensionContext,
    cfg: ExtensionConfig,
): Promise<string | undefined> {
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

/**
 * Get the FULL file prefix and suffix.
 *
 * Unlike the old sliding-window approach, we now send the ENTIRE current file:
 *   prefix = everything from the start of the file up to the cursor
 *   suffix = everything from the cursor to the end of the file
 *
 * This is the key insight for KV-cache friendliness: between keystrokes,
 * only ONE character shifts from suffix to prefix — the vast majority of
 * tokens stay at identical positions, allowing DeepSeek's prefix-caching
 * to reuse attention states for ~99%+ of the prompt.
 */
function getFullFilePrefixSuffix(
    document: vscode.TextDocument,
    position: vscode.Position,
): { prefix: string; suffix: string; offset: number } {
    const offset = document.offsetAt(position);
    const docEnd = document.offsetAt(document.lineAt(document.lineCount - 1).range.end);

    const prefix = document.getText(new vscode.Range(document.positionAt(0), position));
    const suffix = document.getText(new vscode.Range(position, document.positionAt(docEnd)));

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
 * The prompt is constructed as:
 *   [preamble (other project files)] + [current file prefix before cursor]
 * The suffix is:
 *   [current file content after cursor]
 *
 * When `cfg.streamEnabled` is true:
 *   1. The function returns as soon as `cfg.streamTokens` tokens have been
 *      collected, giving VS Code an *instant* inline completion.
 *   2. The remainder of the stream is read in the background and stored in
 *      `streamCache`.  On the very next keystroke the provider will serve the
 *      next chunk from cache — **no API call needed**.
 */
async function requestFimStream(
    apiKey: string,
    cfg: ExtensionConfig,
    fullPrompt: string,
    suffix: string,
    cacheKey: string,
    token: vscode.CancellationToken,
): Promise<{ text: string; isComplete: boolean } | undefined> {
    const url = joinUrl(cfg.baseUrl, cfg.completionsPath);
    const payload: Record<string, unknown> = {
        model: cfg.model,
        prompt: fullPrompt,
        max_tokens: cfg.maxTokens,
        temperature: cfg.temperature,
        top_p: cfg.topP,
        stream: true,
    };

    if (cfg.withSuffix && suffix.length > 0) {
        payload.suffix = suffix;
    }

    if (cfg.stop.length > 0) {
        (payload as Record<string, unknown>).stop = cfg.stop;
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

    // A rough heuristic: avg token ≈ 4 chars for code.
    const streamCharTarget = cfg.streamEnabled
        ? cfg.streamTokens * 4
        : Number.MAX_SAFE_INTEGER;

    try {
        const start = Date.now();
        if (cfg.logRequests) {
            output.appendLine(
                `[req] model=${cfg.model} prompt_len=${fullPrompt.length} suffix_len=${suffix.length} max_tokens=${cfg.maxTokens} stream_tokens=${cfg.streamTokens}`,
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
                entry.isComplete = true;
                entry.lastAccess = Date.now();
                entry.resolveDone();
                break;
            }

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (!line.startsWith('data: ')) {
                    continue;
                }
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    entry.isComplete = true;
                    entry.lastAccess = Date.now();
                    entry.resolveDone();
                    break;
                }

                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.text;
                    if (delta) {
                        if (firstToken) {
                            firstToken = false;
                            if (cfg.logRequests) {
                                output.appendLine(`[stream] TTFB: ${Date.now() - start}ms`);
                            }
                        }
                        entry.fullText += delta;
                        entry.lastAccess = Date.now();
                    }
                } catch {
                    // Ignore malformed SSE lines.
                }
            }

            // ---- early return: enough characters for the first chunk ---------
            if (
                !earlyResolved &&
                cfg.streamEnabled &&
                entry.fullText.length >= streamCharTarget
            ) {
                earlyResolved = true;
                const cleaned = cleanupCompletion(entry.fullText);
                entry.fullText = cleaned;
                entry.returnedChars = cleaned.length;

                if (cfg.logRequests) {
                    output.appendLine(
                        `[stream] early-return after ${Date.now() - start}ms, ${cleaned.length} chars`,
                    );
                }

                // Continue reading in background, return the first chunk now.
                (async () => {
                    try {
                        await continueReadingInBackground(
                            reader, decoder, entry, cfg, token, start,
                        );
                    } catch {
                        // Reader already closed or cancelled.
                    }
                })();

                return {
                    text: cleaned.trim().length > 0 ? cleaned : entry.fullText,
                    isComplete: false,
                };
            }
        }

        // ---- stream ended (or early-return not enabled) ----------------------
        if (cfg.logRequests) {
            output.appendLine(
                `[req] completed in ${Date.now() - start}ms, response: ${entry.fullText.length} chars`,
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
                if (!line.startsWith('data: ')) {
                    continue;
                }
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    entry.isComplete = true;
                    entry.lastAccess = Date.now();
                    entry.resolveDone();
                    return;
                }

                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.text;
                    if (delta) {
                        entry.fullText += delta;
                        entry.lastAccess = Date.now();
                    }
                } catch {
                    // Ignore.
                }
            }
        }
    } catch {
        entry.isComplete = true;
        entry.resolveDone();
    } finally {
        if (cfg.logRequests) {
            output.appendLine(
                `[stream-bg] finished in ${Date.now() - start}ms, total: ${entry.fullText.length} chars`,
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

            // ── Get full-file prefix/suffix (no sliding window!) ─────────
            const { prefix, suffix, offset } = getFullFilePrefixSuffix(document, position);

            // Don't bother if there's essentially nothing before the cursor.
            if (prefix.trimEnd().length < cfg.minPrefixChars) {
                return undefined;
            }

            // ── Get cross-file project preamble ──────────────────────────
            const preamble = await getPreamble(document.uri, cfg);

            // ── Construct the full prompt: preamble + current file prefix ─
            const fullPrompt = preamble ? preamble + prefix : prefix;

            // ── cache-first strategy ─────────────────────────────────────
            const cacheKey = makeCacheKey(document, offset, cfg.model);

            // 1) Check if we have a cached stream continuation (exact or nearby offset).
            const cached = findNearbyCacheEntry(document, offset, cfg.model);
            if (cached && cached.returnedChars < cached.fullText.length) {
                cached.lastAccess = Date.now();
                const available = cached.fullText.slice(cached.returnedChars);

                const chunkSize = cfg.streamTokens * 4;
                const newText = available.length > chunkSize
                    ? available.slice(0, chunkSize)
                    : available;
                cached.returnedChars += newText.length;

                const cleaned = cleanupCompletion(newText);
                if (cleaned.trim().length > 0) {
                    if (cfg.logRequests) {
                        output.appendLine(
                            `[cache-hit] serving ${cleaned.length} cached chars ` +
                            `(buffered: ${cached.fullText.length - cached.returnedChars})`,
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

            // 2) If a stream for this position is already in-flight, wait for it.
            const inflight = streamCache.get(cacheKey);
            if (inflight && !inflight.isComplete && inflight.fullText.length === 0) {
                const streamCharTarget = cfg.streamTokens * 4;
                const waitStart = Date.now();
                while (
                    inflight.fullText.length < streamCharTarget &&
                    !inflight.isComplete &&
                    Date.now() - waitStart < 2000
                ) {
                    await sleep(50, token);
                    if (token.isCancellationRequested) {
                        return undefined;
                    }
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

            // 3) No usable cache — start a fresh streaming request.
            const result = await requestFimStream(
                apiKey,
                cfg,
                fullPrompt,
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

/* ------------------------------------------------------------------ */
/*  Commands                                                           */
/* ------------------------------------------------------------------ */

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
        vscode.window.showWarningMessage('FIM: no API key. Run "FIM: Set API Key" first.');
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
    vscode.window.showInformationMessage(
        `FIM inline completion ${!current ? 'enabled' : 'disabled'}.`,
    );
}

/* ------------------------------------------------------------------ */
/*  Activation / Deactivation                                          */
/* ------------------------------------------------------------------ */

export function activate(context: vscode.ExtensionContext): void {
    output.appendLine('FIM extension activated.');

    context.subscriptions.push(output);

    context.subscriptions.push(
        vscode.commands.registerCommand('FIM.setApiKey', () => setApiKey(context)),
        vscode.commands.registerCommand('FIM.clearApiKey', () => clearApiKey(context)),
        vscode.commands.registerCommand('FIM.testRequest', () => testRequest(context)),
        vscode.commands.registerCommand('FIM.toggle', () => toggleEnabled()),
    );

    // Set up preamble file watcher so we refresh cross-file context on
    // project file create/delete events.
    setupPreambleWatcher(context);

    // Invalidate preamble when workspace folders change.
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => invalidatePreamble()),
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
    preambleCache = undefined;
    if (preambleWatcher) {
        preambleWatcher.dispose();
        preambleWatcher = undefined;
    }
}
