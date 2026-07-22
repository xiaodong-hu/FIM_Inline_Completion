import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedRequestRegistry, type AbortableRequest } from './requestRegistry.js';

interface TestRequest extends AbortableRequest {
    aborted: boolean;
}

function request(startedAt: number): TestRequest {
    return {
        startedAt,
        aborted: false,
        abort() {
            this.aborted = true;
        },
    };
}

test('aborts the oldest background request when the bound is exceeded', () => {
    const registry = new BoundedRequestRegistry<TestRequest>(2);
    const oldest = request(10);
    const middle = request(20);
    const newest = request(30);

    registry.add('oldest', oldest);
    registry.add('middle', middle);
    registry.add('newest', newest);

    assert.equal(registry.size, 2);
    assert.equal(oldest.aborted, true);
    assert.equal(middle.aborted, false);
    assert.equal(newest.aborted, false);
    assert.equal(registry.get('oldest'), undefined);
});

test('applies a smaller configured bound immediately', () => {
    const registry = new BoundedRequestRegistry<TestRequest>(3);
    const first = request(10);
    const second = request(20);
    const third = request(30);
    registry.add('first', first);
    registry.add('second', second);
    registry.add('third', third);

    registry.configure(1);

    assert.equal(registry.size, 1);
    assert.equal(first.aborted, true);
    assert.equal(second.aborted, true);
    assert.equal(third.aborted, false);
});

test('discards matching requests and protects a replacement from stale cleanup', () => {
    const registry = new BoundedRequestRegistry<TestRequest>(2);
    const oldRequest = request(10);
    const replacement = request(20);
    const other = request(30);
    registry.add('same-key', oldRequest);
    registry.add('same-key', replacement);
    registry.add('other', other);

    assert.equal(oldRequest.aborted, true);
    assert.equal(registry.delete('same-key', oldRequest), false);
    assert.equal(registry.get('same-key'), replacement);

    registry.discardWhere(item => item === other);
    assert.equal(other.aborted, true);
    assert.equal(registry.size, 1);
});

test('clear aborts every retained request', () => {
    const registry = new BoundedRequestRegistry<TestRequest>(2);
    const first = request(10);
    const second = request(20);
    registry.add('first', first);
    registry.add('second', second);

    registry.clear();

    assert.equal(registry.size, 0);
    assert.equal(first.aborted, true);
    assert.equal(second.aborted, true);
});

test('remains bounded during a burst of distinct request snapshots', () => {
    const registry = new BoundedRequestRegistry<TestRequest>(4);
    const requests = Array.from({ length: 1_000 }, (_, index) => request(index));

    for (const [index, item] of requests.entries()) {
        registry.add(`snapshot-${index}`, item);
    }

    assert.equal(registry.size, 4);
    assert.equal(requests.filter(item => item.aborted).length, 996);
    assert.deepEqual(
        requests.slice(-4).map(item => item.aborted),
        [false, false, false, false],
    );
});
