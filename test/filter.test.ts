import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_FILTER_LIMIT,
  FilterError,
  MAX_FILTER_LIMIT,
  matchesAnyFilter,
  matchesFilter,
  normalizeFilter,
} from '../src/protocol/filter.js';
import { createSignedEvent, createTestKey } from './helpers.js';

test('规范化 filter：默认 limit、hex 小写、忽略未知字段', () => {
  const filter = normalizeFilter({ ids: ['ABCDEF'], unknownField: true });

  assert.equal(filter.limit, DEFAULT_FILTER_LIMIT);
  assert.deepEqual(filter.ids, ['abcdef']);
  assert.equal('unknownField' in filter, false);
});

test('limit 上限与下限', () => {
  assert.equal(normalizeFilter({ limit: 999999 }).limit, MAX_FILTER_LIMIT);
  assert.equal(normalizeFilter({ limit: 0 }).limit, 0);
  assert.equal(normalizeFilter({ limit: 10 }).limit, 10);
});

test('标签过滤键与值被保留', () => {
  const filter = normalizeFilter({ '#e': ['a'.repeat(64)], '#t': ['nostr'] });

  assert.deepEqual(filter.tags?.['e'], ['a'.repeat(64)]);
  assert.deepEqual(filter.tags?.['t'], ['nostr']);
});

test('非法 filter 抛出 FilterError', () => {
  assert.throws(() => normalizeFilter({ ids: [123] }), FilterError);
  assert.throws(() => normalizeFilter({ ids: ['xyz'] }), FilterError);
  assert.throws(() => normalizeFilter({ kinds: ['1'] }), FilterError);
  assert.throws(() => normalizeFilter({ since: -1 }), FilterError);
  assert.throws(() => normalizeFilter({ limit: -1 }), FilterError);
  assert.throws(() => normalizeFilter({ '#e': 'abc' }), FilterError);
});

test('matchesFilter 与 SQL 语义一致的断言', () => {
  const key = createTestKey();
  const now = Math.floor(Date.now() / 1000);
  const event = createSignedEvent(key, {
    kind: 1,
    created_at: 1000,
    tags: [
      ['e', 'b'.repeat(64)],
      ['t', 'nostr'],
    ],
  });

  const match = (raw: Record<string, unknown>): boolean => matchesFilter(event, normalizeFilter(raw), now);

  assert.equal(match({}), true);
  assert.equal(match({ ids: [event.id.slice(0, 8)] }), true);
  assert.equal(match({ ids: ['f'.repeat(8)] }), false);
  assert.equal(match({ ids: [] }), false);
  assert.equal(match({ authors: [key.pubkey.slice(0, 8)] }), true);
  assert.equal(match({ authors: [] }), false);
  assert.equal(match({ kinds: [1, 2] }), true);
  assert.equal(match({ kinds: [2] }), false);
  assert.equal(match({ kinds: [] }), false);
  assert.equal(match({ since: 1000 }), true);
  assert.equal(match({ since: 1001 }), false);
  assert.equal(match({ until: 1000 }), true);
  assert.equal(match({ until: 999 }), false);
  assert.equal(match({ '#e': ['b'.repeat(64)] }), true);
  assert.equal(match({ '#e': ['c'.repeat(64)] }), false);
  assert.equal(match({ '#e': [] }), false);
  assert.equal(match({ '#t': ['nostr'], '#e': ['b'.repeat(64)] }), true);
  assert.equal(matchesAnyFilter(event, [normalizeFilter({ kinds: [2] }), normalizeFilter({ kinds: [1] })], now), true);
});

test('已过期事件不参与匹配', () => {
  const now = Math.floor(Date.now() / 1000);
  const event = createSignedEvent(createTestKey(), { tags: [['expiration', String(now - 1)]] });

  assert.equal(matchesFilter(event, normalizeFilter({}), now), false);
});
