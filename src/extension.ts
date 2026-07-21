import * as vscode from 'vscode';
import {
    CompletionCache,
    makeSnapshotKey,
    type CompletionCacheEntry,
    type CompletionContext,
} from './completionCache.js';
import {
    startFimCompletion,
    type FimCompletionTask,
    type FimUsage,
} from './fimClient.js';

const SECRET_KEY = 'FIM.apiKey';
const output = vscode.window.createOutputChannel('FIM');

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
    requestTimeoutMs: number;
    debounceMs: number;
    revalidateDelayMs: number;
    stop: string[];
    logRequests: boolean;
    streamEnabled: boolean;
    streamTokens: number;
    localCacheTtlMs: number;
    localCacheMaxEntries: number;
    minPrefixChars: number;
}

interface DocumentFimContext extends CompletionContext {
    documentVersion: number;
    cursorOffset: number;
}

interface ActiveRequest {
    entry: CompletionCacheEntry;
    task: FimCompletionTask;
    startedAt: number;
}

const completionCache = new CompletionCache();
const inFlight = new Map<string, ActiveRequest>();
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
let warnedMissingKey = false;

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
        temperature: cfg.get<number>('temperature', 0),
        topP: cfg.get<number>('topP', 0.9),
        requestTimeoutMs: cfg.get<number>('requestTimeoutMs', 30_000),
        debounceMs: cfg.get<number>('debounceMs', 250),
        revalidateDelayMs: cfg.get<number>('revalidateDelayMs', 1_500),
        stop: cfg.get<string[]>('stop', []),
        logRequests: cfg.get<boolean>('logRequests', false),
        streamEnabled: cfg.get<boolean>('streamEnabled', true),
        streamTokens: cfg.get<number>('streamTokens', 5),
        localCacheTtlMs: cfg.get<number>('localCacheTtlMs', 5 * 60_000),
        localCacheMaxEntries: cfg.get<number>('localCacheMaxEntries', 64),
        minPrefixChars: cfg.get<number>('minPrefixChars', 4),
    };
}

function joinUrl(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function makeRequestKey(cfg: ExtensionConfig): string {
    return JSON.stringify({
        provider: cfg.provider,
        url: joinUrl(cfg.baseUrl, cfg.completionsPath),
        model: cfg.model,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        topP: cfg.topP,
        stop: cfg.stop,
    });
}

/** Return the complete document split exactly at the cursor. */
function getDocumentContext(
    document: vscode.TextDocument,
    position: vscode.Position,
    cfg: ExtensionConfig,
): DocumentFimContext {
    const text = document.getText();
    const cursorOffset = document.offsetAt(position);
    return {
        documentUri: document.uri.toString(),
        documentVersion: document.version,
        cursorOffset,
        prefix: text.slice(0, cursorOffset),
        suffix: text.slice(cursorOffset),
        requestKey: makeRequestKey(cfg),
    };
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
    return (
        document.uri.scheme === 'file' ||
        document.uri.scheme === 'untitled' ||
        document.uri.scheme === 'vscode-notebook-cell'
    );
}

function sleep(ms: number, token: vscode.CancellationToken): Promise<boolean> {
    if (token.isCancellationRequested) {
        return Promise.resolve(false);
    }
    if (ms <= 0) {
        return Promise.resolve(true);
    }
    return new Promise(resolve => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let disposable: vscode.Disposable | undefined;
        const finish = (completed: boolean): void => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeout) {
                clearTimeout(timeout);
            }
            disposable?.dispose();
            resolve(completed);
        };
        timeout = setTimeout(() => finish(true), ms);
        disposable = token.onCancellationRequested(() => finish(false));
    });
}

function waitWithCancellation<T>(
    promise: Promise<T>,
    token: vscode.CancellationToken,
): Promise<T | undefined> {
    if (token.isCancellationRequested) {
        return Promise.resolve(undefined);
    }
    return new Promise(resolve => {
        let settled = false;
        let disposable: vscode.Disposable | undefined;
        const finish = (value: T | undefined): void => {
            if (settled) {
                return;
            }
            settled = true;
            disposable?.dispose();
            resolve(value);
        };
        disposable = token.onCancellationRequested(() => finish(undefined));
        void promise.then(value => finish(value), () => finish(undefined));
    });
}

async function getApiKey(
    context: vscode.ExtensionContext,
    cfg: ExtensionConfig,
): Promise<string | undefined> {
    const stored = await context.secrets.get(SECRET_KEY);
    if (stored?.trim()) {
        return stored.trim();
    }
    const fromEnvironment = process.env[cfg.apiKeyEnvVar];
    return fromEnvironment?.trim() || undefined;
}

function logUsage(usage: FimUsage | undefined): void {
    if (!usage) {
        return;
    }
    const cacheableInput = usage.cacheHitTokens + usage.cacheMissTokens;
    const hitRate = cacheableInput > 0
        ? ((usage.cacheHitTokens / cacheableInput) * 100).toFixed(1)
        : '0.0';
    output.appendLine(
        `[usage] prompt=${usage.promptTokens} hit=${usage.cacheHitTokens} ` +
        `miss=${usage.cacheMissTokens} hit_rate=${hitRate}% ` +
        `completion=${usage.completionTokens} total=${usage.totalTokens}`,
    );
}

/**
 * Deduplicate an exact network request and let it continue after VS Code
 * cancels a provider call. Once the input has been sent, finishing the cheap
 * output is useful: it populates the local cache for the next keystroke.
 */
function startRequest(
    apiKey: string,
    cfg: ExtensionConfig,
    fimContext: DocumentFimContext,
): ActiveRequest {
    completionCache.configure({
        ttlMs: cfg.localCacheTtlMs,
        maxEntries: cfg.localCacheMaxEntries,
    });

    const snapshotKey = makeSnapshotKey(fimContext);
    const existing = inFlight.get(snapshotKey);
    if (existing) {
        return existing;
    }

    const entry = completionCache.create(fimContext);
    entry.text = '';
    entry.complete = false;
    entry.createdAt = Date.now();
    entry.lastAccess = entry.createdAt;

    const startedAt = Date.now();
    let firstTextLogged = false;
    if (cfg.logRequests) {
        output.appendLine(
            `[request] model=${cfg.model} prefix_chars=${fimContext.prefix.length} ` +
            `suffix_chars=${fimContext.suffix.length} max_tokens=${cfg.maxTokens}`,
        );
    }

    const task = startFimCompletion({
        url: joinUrl(cfg.baseUrl, cfg.completionsPath),
        apiKey,
        model: cfg.model,
        prompt: fimContext.prefix,
        suffix: fimContext.suffix,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        topP: cfg.topP,
        stop: cfg.stop,
        timeoutMs: cfg.requestTimeoutMs,
        initialChars: Math.max(1, cfg.streamTokens * 4),
        includeUsage: cfg.provider === 'deepseek',
        onText: text => {
            entry.text = text;
            entry.lastAccess = Date.now();
            if (!firstTextLogged && text.length > 0) {
                firstTextLogged = true;
                if (cfg.logRequests) {
                    output.appendLine(`[stream] first text after ${Date.now() - startedAt}ms`);
                }
            }
        },
    });

    const active: ActiveRequest = { entry, task, startedAt };
    inFlight.set(snapshotKey, active);

    void task.done.then(result => {
        entry.text = result.text;
        entry.complete = true;
        entry.lastAccess = Date.now();
        if (result.error) {
            output.appendLine(`[error] ${result.error.message}`);
            // Retain a partial generation, but do not negative-cache a failure.
            if (entry.text.length === 0) {
                completionCache.delete(entry);
            }
        } else if (cfg.logRequests) {
            output.appendLine(
                `[response] completed in ${Date.now() - startedAt}ms, chars=${entry.text.length}`,
            );
        }
        if (cfg.logRequests) {
            logUsage(result.usage);
        }
    }).finally(() => {
        if (inFlight.get(snapshotKey) === active) {
            inFlight.delete(snapshotKey);
        }
    });

    return active;
}

function toInlineCompletion(
    text: string,
    position: vscode.Position,
): vscode.InlineCompletionList | undefined {
    if (text.length === 0 || text.trim().length === 0) {
        return undefined;
    }
    return new vscode.InlineCompletionList([
        new vscode.InlineCompletionItem(text, new vscode.Range(position, position)),
    ]);
}

function currentEditorMatches(fimContext: DocumentFimContext, cfg: ExtensionConfig): boolean {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== fimContext.documentUri) {
        return false;
    }
    const current = getDocumentContext(editor.document, editor.selection.active, cfg);
    return makeSnapshotKey(current) === makeSnapshotKey(fimContext);
}

/**
 * Stale-while-revalidate for partial acceptance.
 *
 * Each accepted word immediately exposes the still-valid local remainder.
 * Only after editing pauses do we ask the model for a fresh generation at the
 * new cursor. Repeated word acceptance resets this timer, avoiding one API
 * request per word while still allowing the suggestion to change dynamically.
 */
function scheduleRevalidation(
    extensionContext: vscode.ExtensionContext,
    fimContext: DocumentFimContext,
    cfg: ExtensionConfig,
): void {
    const previous = refreshTimers.get(fimContext.documentUri);
    if (previous) {
        clearTimeout(previous);
    }

    const timer = setTimeout(() => {
        refreshTimers.delete(fimContext.documentUri);
        void (async () => {
            if (!currentEditorMatches(fimContext, cfg)) {
                return;
            }
            const apiKey = await getApiKey(extensionContext, cfg);
            if (!apiKey || !currentEditorMatches(fimContext, cfg)) {
                return;
            }

            const active = startRequest(apiKey, cfg, fimContext);
            const firstText = await active.task.firstText;
            if (firstText && currentEditorMatches(fimContext, cfg)) {
                // Ask VS Code to query again so the freshly generated entry can
                // replace the older cached continuation.
                await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            }
        })();
    }, cfg.revalidateDelayMs);
    refreshTimers.set(fimContext.documentUri, timer);
}

function buildProvider(
    extensionContext: vscode.ExtensionContext,
): vscode.InlineCompletionItemProvider {
    return {
        async provideInlineCompletionItems(document, position, inlineContext, token) {
            const cfg = getConfig();
            if (!cfg.enabled || !isSupportedDocument(document)) {
                return undefined;
            }

            // A visible suggestion widget has stricter replacement semantics.
            // Skipping here also avoids paid requests whose result VS Code would hide.
            if (inlineContext.selectedCompletionInfo) {
                return undefined;
            }

            completionCache.configure({
                ttlMs: cfg.localCacheTtlMs,
                maxEntries: cfg.localCacheMaxEntries,
            });
            const initialVersion = document.version;
            let fimContext = getDocumentContext(document, position, cfg);
            if (fimContext.prefix.trimEnd().length < cfg.minPrefixChars) {
                return undefined;
            }

            // Local lookup happens before debounce and before API-key access.
            const cached = completionCache.find(fimContext);
            if (cached) {
                if (cfg.logRequests) {
                    output.appendLine(
                        `[local-cache] ${cached.kind} accepted_chars=${cached.acceptedText.length} ` +
                        `remaining_chars=${cached.remainingText.length}`,
                    );
                }
                if (cached.kind === 'continuation') {
                    scheduleRevalidation(extensionContext, fimContext, cfg);
                }
                return toInlineCompletion(cached.remainingText, position);
            }

            if (!await sleep(cfg.debounceMs, token) || document.version !== initialVersion) {
                return undefined;
            }

            // Capture again after debounce. This is the exact pair sent to the API.
            fimContext = getDocumentContext(document, position, cfg);
            const cachedAfterDebounce = completionCache.find(fimContext);
            if (cachedAfterDebounce) {
                return toInlineCompletion(cachedAfterDebounce.remainingText, position);
            }

            const apiKey = await getApiKey(extensionContext, cfg);
            if (!apiKey) {
                if (!warnedMissingKey) {
                    warnedMissingKey = true;
                    void vscode.window.showWarningMessage(
                        `FIM: no API key. Run "FIM: Set API Key" or set ${cfg.apiKeyEnvVar}.`,
                    );
                }
                return undefined;
            }

            const active = startRequest(apiKey, cfg, fimContext);
            const text = cfg.streamEnabled
                ? await waitWithCancellation(active.task.firstText, token)
                : (await waitWithCancellation(active.task.done, token))?.text;

            if (token.isCancellationRequested || !text) {
                return undefined;
            }
            return toInlineCompletion(text, position);
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
    warnedMissingKey = false;
    void vscode.window.showInformationMessage('FIM API key saved.');
}

async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete(SECRET_KEY);
    void vscode.window.showInformationMessage('FIM API key cleared.');
}

async function testRequest(context: vscode.ExtensionContext): Promise<void> {
    const cfg = getConfig();
    const apiKey = await getApiKey(context, cfg);
    if (!apiKey) {
        void vscode.window.showWarningMessage('FIM: no API key. Run "FIM: Set API Key" first.');
        return;
    }

    const task = startFimCompletion({
        url: joinUrl(cfg.baseUrl, cfg.completionsPath),
        apiKey,
        model: cfg.model,
        prompt: 'def fib(a):\n    ',
        suffix: '\n    return fib(a-1) + fib(a-2)',
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        topP: cfg.topP,
        stop: cfg.stop,
        timeoutMs: cfg.requestTimeoutMs,
        initialChars: Number.MAX_SAFE_INTEGER,
        includeUsage: cfg.provider === 'deepseek',
    });
    const result = await task.done;
    if (!result.error && result.text.trim()) {
        output.appendLine(`[test completion]\n${result.text}`);
        logUsage(result.usage);
        output.show(true);
        void vscode.window.showInformationMessage('FIM test succeeded. See the FIM output channel.');
        return;
    }

    if (result.error) {
        output.appendLine(`[test error] ${result.error.message}`);
    }
    output.show(true);
    void vscode.window.showWarningMessage('FIM test failed. See the FIM output channel.');
}

async function toggleEnabled(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('FIM');
    const current = cfg.get<boolean>('enabled', true);
    await cfg.update('enabled', !current, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
        `FIM inline completion ${!current ? 'enabled' : 'disabled'}.`,
    );
}

export function activate(context: vscode.ExtensionContext): void {
    output.appendLine('FIM extension activated.');
    context.subscriptions.push(
        output,
        vscode.commands.registerCommand('FIM.setApiKey', () => setApiKey(context)),
        vscode.commands.registerCommand('FIM.clearApiKey', () => clearApiKey(context)),
        vscode.commands.registerCommand('FIM.testRequest', () => testRequest(context)),
        vscode.commands.registerCommand('FIM.toggle', () => toggleEnabled()),
        vscode.languages.registerInlineCompletionItemProvider(
            [
                { scheme: 'file', pattern: '**' },
                { scheme: 'untitled', pattern: '**' },
                { scheme: 'vscode-notebook-cell', pattern: '**' },
            ],
            buildProvider(context),
        ),
    );
}

export function deactivate(): void {
    for (const timer of refreshTimers.values()) {
        clearTimeout(timer);
    }
    refreshTimers.clear();
    for (const active of inFlight.values()) {
        active.task.abort();
    }
    inFlight.clear();
    completionCache.clear();
}
