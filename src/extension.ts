import * as vscode from 'vscode';

// import * as https from 'https';
// const agent = new https.Agent({ keepAlive: true });

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
    prefixChars: number;
    suffixChars: number;
    withSuffix: boolean;
    minPrefixChars: number;
    requestTimeoutMs: number;
    debounceMs: number;
    stop: string[];
    logRequests: boolean;
}

interface CompletionChoice {
    text?: string;
}

interface CompletionResponse {
    choices?: CompletionChoice[];
    error?: unknown;
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



async function requestFim(
    apiKey: string,
    cfg: ExtensionConfig,
    prefix: string,
    suffix: string,
    token: vscode.CancellationToken,
): Promise<string | undefined> {
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

    try {
        const start = Date.now();
        if (cfg.logRequests) {
            output.appendLine(`[req] model=${cfg.model} prefix=${prefix.length}suffix=${suffix.length} max_tokens=${cfg.maxTokens}`);
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
            // agent, // reuse connection
        });

        if (!response.ok) {
            const errText = await response.text();
            output.appendLine(`[http ${response.status}] ${errText}`);
            return undefined;
        }

        // Read the stream
        const reader = response.body?.getReader();
        if (!reader) {
            return undefined;
        }

        const decoder = new TextDecoder();
        let fullText = '';
        let firstToken = true;

        while (true) {
            if (token.isCancellationRequested) {
                reader.cancel();
                return undefined;
            }

            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') break;

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
                        fullText += text;
                    }
                } catch { }
            }
        }

        const total = Date.now() - start;
        if (cfg.logRequests) {
            output.appendLine(`[req] completed in ${total}ms, response length: ${fullText.length} chars`);
        }

        if (token.isCancellationRequested) return undefined;

        const cleaned = cleanupCompletion(fullText);
        return cleaned.trim().length > 0 ? cleaned : undefined;

    } catch (err) {
        if (!token.isCancellationRequested) {
            output.appendLine(`[err] ${String(err)}`);
        }
        return undefined;
    } finally {
        clearTimeout(timeout);
        cancelDisposable.dispose();
    }
}


function buildProvider(context: vscode.ExtensionContext): vscode.InlineCompletionItemProvider {
    let warnedMissingKey = false;
    let lastCacheKey = '';
    let lastCompletion: string | undefined;

    return {
        async provideInlineCompletionItems(document, position, _inlineContext, token) {
            const cfg = getConfig();
            if (!cfg.enabled) {
                return undefined;
            }

            if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
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

            const cacheKey = [document.uri.toString(), document.version, offset, cfg.model, cfg.maxTokens].join('|');
            if (cacheKey === lastCacheKey && lastCompletion) {
                return new vscode.InlineCompletionList([
                    new vscode.InlineCompletionItem(lastCompletion, new vscode.Range(position, position)),
                ]);
            }

            const completion = await requestFim(apiKey, cfg, prefix, suffix, token);
            if (!completion || token.isCancellationRequested) {
                return undefined;
            }

            lastCacheKey = cacheKey;
            lastCompletion = completion;

            return new vscode.InlineCompletionList([
                new vscode.InlineCompletionItem(completion, new vscode.Range(position, position)),
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
            ],
            provider,
        ),
    );
}

export function deactivate(): void {
    // Nothing to clean up beyond disposables registered in activate().
}
