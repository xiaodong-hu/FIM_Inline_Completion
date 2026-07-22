import assert from 'node:assert/strict';
import test from 'node:test';
import {
    CompletionCache,
    makeSnapshotKey,
    type CompletionContext,
} from './completionCache.js';

function context(prefix: string, suffix = '\n}', requestKey = 'model-settings'): CompletionContext {
    return {
        documentUri: 'file:///workspace/example.ts',
        prefix,
        suffix,
        requestKey,
    };
}

test('returns an exact cached completion without another request', () => {
    const cache = new CompletionCache();
    const original = context('const answer = ');
    const entry = cache.create(original, 100);
    entry.text = 'computeAnswer();';
    entry.complete = true;

    const match = cache.find(original, 101);
    assert.equal(match?.kind, 'exact');
    assert.equal(match?.acceptedText, '');
    assert.equal(match?.remainingText, 'computeAnswer();');
});

test('reuses only the remainder after exact partial acceptance', () => {
    const cache = new CompletionCache();
    const entry = cache.create(context('return '));
    entry.text = 'calculateTotal(items);';
    entry.complete = true;

    const match = cache.find(context('return calculate'));
    assert.equal(match?.kind, 'continuation');
    assert.equal(match?.acceptedText, 'calculate');
    assert.equal(match?.remainingText, 'Total(items);');
});

test('recognizes VS Code newline normalization during partial acceptance', () => {
    const cache = new CompletionCache();
    const entry = cache.create(context('if (ready) {'));
    entry.text = '\n    run();\n}';
    entry.complete = true;

    const match = cache.find(context('if (ready) {\r\n    run();'));
    assert.equal(match?.kind, 'continuation');
    assert.equal(match?.remainingText, '\n}');
});

test('rejects nearby edits that do not match the generated completion', () => {
    const cache = new CompletionCache();
    const entry = cache.create(context('return '));
    entry.text = 'calculateTotal(items);';
    entry.complete = true;

    assert.equal(cache.find(context('return somethingElse')), undefined);
});

test('rejects a completion when any suffix content changed', () => {
    const cache = new CompletionCache();
    const entry = cache.create(context('return '));
    entry.text = 'calculateTotal(items);';
    entry.complete = true;

    assert.equal(cache.find(context('return calculate', '\n};')), undefined);
});

test('prefers a revalidated completion generated from a longer prefix', () => {
    const cache = new CompletionCache();
    const first = cache.create(context('con'), 100);
    first.text = 'sole.log(value);';
    first.complete = true;

    const refreshed = cache.create(context('console.'), 200);
    refreshed.text = 'warn(error);';
    refreshed.complete = true;

    const match = cache.find(context('console.'), 201);
    assert.equal(match?.entry.id, refreshed.id);
    assert.equal(match?.remainingText, 'warn(error);');
});

test('negative-caches a successful empty completion but not an in-flight entry', () => {
    const cache = new CompletionCache();
    const entry = cache.create(context('value = '));

    assert.equal(cache.find(context('value = ')), undefined);
    entry.complete = true;
    assert.equal(cache.find(context('value = '))?.remainingText, '');
});

test('expires old entries and enforces the configured entry bound', () => {
    const cache = new CompletionCache({ ttlMs: 50, maxEntries: 2 });
    cache.create(context('a'), 0).complete = true;
    cache.create(context('b'), 10).complete = true;
    cache.create(context('c'), 20).complete = true;
    assert.equal(cache.size, 2);

    assert.equal(cache.find(context('b'), 100), undefined);
    assert.equal(cache.size, 0);
});

test('supports proactive idle pruning and document cleanup', () => {
    const cache = new CompletionCache({ ttlMs: 50 });
    cache.create(context('old'), 0).complete = true;
    cache.prune(51);
    assert.equal(cache.size, 0);

    cache.create(context('first'), 100).complete = true;
    cache.create({
        ...context('second'),
        documentUri: 'file:///workspace/other.ts',
    }, 100).complete = true;
    cache.deleteDocument('file:///workspace/example.ts');
    assert.equal(cache.size, 1);
});

test('snapshot identity includes prefix, suffix, document, and request settings', () => {
    const base = context('prefix', 'suffix');
    assert.notEqual(makeSnapshotKey(base), makeSnapshotKey({ ...base, prefix: 'prefix!' }));
    assert.notEqual(makeSnapshotKey(base), makeSnapshotKey({ ...base, suffix: 'suffix!' }));
    assert.notEqual(makeSnapshotKey(base), makeSnapshotKey({ ...base, documentUri: 'file:///other' }));
    assert.notEqual(makeSnapshotKey(base), makeSnapshotKey({ ...base, requestKey: 'other-model' }));
});
