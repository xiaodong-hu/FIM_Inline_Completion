import assert from 'node:assert/strict';
import test from 'node:test';
import { FimHttpError, startFimCompletion, type FimCompletionRequest } from './fimClient.js';

function request(overrides: Partial<FimCompletionRequest> = {}): FimCompletionRequest {
    return {
        url: 'https://api.deepseek.com/beta/completions',
        apiKey: 'secret-test-key',
        model: 'deepseek-v4-pro',
        prompt: 'function answer() { return ',
        suffix: '; }',
        maxTokens: 64,
        temperature: 0,
        topP: 0.9,
        stop: [],
        timeoutMs: 1_000,
        initialChars: 4,
        includeUsage: true,
        ...overrides,
    };
}

function fragmentedSseResponse(): Response {
    const encoder = new TextEncoder();
    const fragments = [
        'data: {"choices":[{"te',
        'xt":"hel"}]}\n\ndata: {"choices":[{"text":"lo"}]}\n',
        '\ndata: {"choices":[],"usage":{"prompt_tokens":20,',
        '"prompt_cache_hit_tokens":15,"prompt_cache_miss_tokens":5,',
        '"completion_tokens":2,"total_tokens":22}}\n\ndata: [DONE]\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const fragment of fragments) {
                controller.enqueue(encoder.encode(fragment));
            }
            controller.close();
        },
    });
    return new Response(body, { status: 200 });
}

test('parses fragmented SSE, returns early text, and records DeepSeek usage', async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return fragmentedSseResponse();
    }) as typeof fetch;

    const updates: string[] = [];
    const task = startFimCompletion(request({ onText: text => updates.push(text) }), fetchMock);
    assert.equal(await task.firstText, 'hello');
    const result = await task.done;

    assert.equal(result.error, undefined);
    assert.equal(result.text, 'hello');
    assert.deepEqual(updates, ['hel', 'hello']);
    assert.equal(result.usage?.cacheHitTokens, 15);
    assert.equal(result.usage?.cacheMissTokens, 5);
    assert.equal(sentBody?.prompt, 'function answer() { return ');
    assert.equal(sentBody?.suffix, '; }');
    assert.deepEqual(sentBody?.stream_options, { include_usage: true });
});

test('always sends the suffix field, including an empty suffix at EOF', async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fetchMock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return fragmentedSseResponse();
    }) as typeof fetch;

    await startFimCompletion(request({ suffix: '', includeUsage: false }), fetchMock).done;
    assert.equal(Object.hasOwn(sentBody ?? {}, 'suffix'), true);
    assert.equal(sentBody?.suffix, '');
    assert.equal(Object.hasOwn(sentBody ?? {}, 'stream_options'), false);
});

test('surfaces HTTP errors without rejecting task promises', async () => {
    const fetchMock = (async () => new Response('bad request', { status: 400 })) as typeof fetch;
    const task = startFimCompletion(request(), fetchMock);

    assert.equal(await task.firstText, undefined);
    const result = await task.done;
    assert.equal(result.text, '');
    assert.equal(result.error instanceof FimHttpError, true);
    assert.equal((result.error as FimHttpError).status, 400);
});
