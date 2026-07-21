export interface FimUsage {
    promptTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    completionTokens: number;
    totalTokens: number;
}

export interface FimCompletionResult {
    text: string;
    usage: FimUsage | undefined;
    error: Error | undefined;
}

export interface FimCompletionRequest {
    url: string;
    apiKey: string;
    model: string;
    prompt: string;
    suffix: string;
    maxTokens: number;
    temperature: number;
    topP: number;
    stop: string[];
    timeoutMs: number;
    /** Resolve firstText after roughly this many generated characters. */
    initialChars: number;
    includeUsage: boolean;
    onText?: (text: string) => void;
}

export interface FimCompletionTask {
    /** An early usable completion, or undefined if the request failed/was empty. */
    firstText: Promise<string | undefined>;
    /** The complete generation and usage accounting. */
    done: Promise<FimCompletionResult>;
    abort: () => void;
}

export class FimHttpError extends Error {
    constructor(
        readonly status: number,
        readonly responseBody: string,
    ) {
        super(`FIM request failed with HTTP ${status}: ${responseBody}`);
        this.name = 'FimHttpError';
    }
}

function sanitizeCompletion(text: string): string {
    return text.replace(/\r\n/g, '\n').replace(/\u0000/g, '');
}

function readUsage(value: unknown): FimUsage | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const usage = value as Record<string, unknown>;
    const number = (key: string): number => {
        const item = usage[key];
        return typeof item === 'number' ? item : 0;
    };
    return {
        promptTokens: number('prompt_tokens'),
        cacheHitTokens: number('prompt_cache_hit_tokens'),
        cacheMissTokens: number('prompt_cache_miss_tokens'),
        completionTokens: number('completion_tokens'),
        totalTokens: number('total_tokens'),
    };
}

/** Incremental SSE parser that preserves JSON split across network chunks. */
class SseDecoder {
    private buffer = '';
    private dataLines: string[] = [];

    constructor(private readonly onData: (data: string) => void) {}

    push(chunk: string): void {
        this.buffer += chunk;
        while (true) {
            const newline = this.buffer.indexOf('\n');
            if (newline < 0) {
                return;
            }
            const rawLine = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            this.consumeLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
        }
    }

    finish(): void {
        if (this.buffer.length > 0) {
            this.consumeLine(this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer);
            this.buffer = '';
        }
        this.dispatch();
    }

    private consumeLine(line: string): void {
        if (line.length === 0) {
            this.dispatch();
            return;
        }
        if (line.startsWith('data:')) {
            const value = line.slice(5);
            this.dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
        }
    }

    private dispatch(): void {
        if (this.dataLines.length === 0) {
            return;
        }
        const data = this.dataLines.join('\n');
        this.dataLines = [];
        this.onData(data);
    }
}

/**
 * Start a DeepSeek-compatible streaming FIM request.
 *
 * `suffix` is unconditionally included in the JSON body, including when it is
 * empty. This keeps the request a true prefix+suffix FIM request at EOF too.
 */
export function startFimCompletion(
    request: FimCompletionRequest,
    fetchImpl: typeof fetch = fetch,
): FimCompletionTask {
    const controller = new AbortController();
    let resolveFirst!: (text: string | undefined) => void;
    let firstResolved = false;
    const firstText = new Promise<string | undefined>(resolve => {
        resolveFirst = resolve;
    });

    const resolveFirstOnce = (text: string | undefined): void => {
        if (!firstResolved) {
            firstResolved = true;
            resolveFirst(text);
        }
    };

    const done = (async (): Promise<FimCompletionResult> => {
        let assembled = '';
        let usage: FimUsage | undefined;
        const timeout = setTimeout(() => controller.abort(), request.timeoutMs);

        try {
            const payload: Record<string, unknown> = {
                model: request.model,
                prompt: request.prompt,
                suffix: request.suffix,
                max_tokens: request.maxTokens,
                temperature: request.temperature,
                top_p: request.topP,
                stream: true,
            };
            if (request.stop.length > 0) {
                payload.stop = request.stop;
            }
            if (request.includeUsage) {
                payload.stream_options = { include_usage: true };
            }

            const response = await fetchImpl(request.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${request.apiKey}`,
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new FimHttpError(response.status, await response.text());
            }

            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error('FIM response did not contain a readable body.');
            }

            let sawDone = false;
            const sse = new SseDecoder(data => {
                if (data === '[DONE]') {
                    sawDone = true;
                    return;
                }

                try {
                    const parsed = JSON.parse(data) as Record<string, unknown>;
                    const parsedUsage = readUsage(parsed.usage);
                    if (parsedUsage) {
                        usage = parsedUsage;
                    }

                    const choices = parsed.choices;
                    if (!Array.isArray(choices) || choices.length === 0) {
                        return;
                    }
                    const firstChoice = choices[0];
                    if (!firstChoice || typeof firstChoice !== 'object') {
                        return;
                    }
                    const delta = (firstChoice as Record<string, unknown>).text;
                    if (typeof delta !== 'string' || delta.length === 0) {
                        return;
                    }

                    assembled = sanitizeCompletion(assembled + delta);
                    request.onText?.(assembled);
                    if (
                        assembled.length >= request.initialChars &&
                        assembled.trim().length > 0
                    ) {
                        resolveFirstOnce(assembled);
                    }
                } catch {
                    // Ignore a malformed event without discarding adjacent events.
                }
            });
            const decoder = new TextDecoder();

            while (!sawDone) {
                const { done: streamDone, value } = await reader.read();
                if (streamDone) {
                    break;
                }
                sse.push(decoder.decode(value, { stream: true }));
            }
            sse.push(decoder.decode());
            sse.finish();

            const text = sanitizeCompletion(assembled);
            resolveFirstOnce(text.trim().length > 0 ? text : undefined);
            return { text, usage, error: undefined };
        } catch (error) {
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            resolveFirstOnce(undefined);
            return { text: sanitizeCompletion(assembled), usage, error: normalizedError };
        } finally {
            clearTimeout(timeout);
        }
    })();

    return {
        firstText,
        done,
        abort: () => controller.abort(),
    };
}
