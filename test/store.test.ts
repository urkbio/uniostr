import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFilter } from '../src/protocol/filter.js';
import { createSignedEvent, createTestKey, createTestStore } from './helpers.js';

test('写入、去重与默认排序', () => {
  const { store } = createTestStore();
  const key = createTestKey();
  const first = createSignedEvent(key, { created_at: 100, content: 'one' });
  const second = createSignedEvent(key, { created_at: 200, content: 'two' });

  assert.equal(store.save(first), 'stored');
  assert.equal(store.save(first), 'duplicate');
  assert.equal(store.save(second), 'stored');

  const ids = store.query([normalizeFilter({})]).map((event) => event.id);
  assert.deepEqual(ids, [second.id, first.id]);
});

test('多 filter 合并、去重与按 filter 生效的 limit', () => {
  const { store } = createTestStore();
  const key = createTestKey();
  const older = createSignedEvent(key, { kind: 1, created_at: 100 });
  const newer = createSignedEvent(key, { kind: 1, created_at: 300 });
  const note = createSignedEvent(key, { kind: 2, created_at: 200 });

  store.save(older);
  store.save(newer);
  store.save(note);

  const ids = store
    .query([normalizeFilter({ kinds: [1], limit: 1 }), normalizeFilter({ kinds: [2] })])
    .map((event) => event.id);
  assert.deepEqual(ids, [newer.id, note.id]);

  const duplicated = store
    .query([normalizeFilter({ kinds: [1] }), normalizeFilter({ authors: [key.pubkey] })])
    .map((event) => event.id);
  assert.equal(duplicated.filter((id) => id === newer.id).length, 1);
});

test('filter 支持 id/author 前缀、标签与时间范围', () => {
  const { store } = createTestStore();
  const key = createTestKey();
  const targetId = 'b'.repeat(64);
  const event = createSignedEvent(key, {
    created_at: 500,
    tags: [
      ['e', targetId],
      ['t', 'nostr'],
    ],
  });
  const other = createSignedEvent(key, { created_at: 800 });
  store.save(event);
  store.save(other);

  const byPrefix = store.query([normalizeFilter({ ids: [event.id.slice(0, 10)] })]);
  assert.deepEqual(byPrefix.map((item) => item.id), [event.id]);

  const byAuthor = store.query([normalizeFilter({ authors: [key.pubkey.slice(0, 12)], until: 600 })]);
  assert.deepEqual(byAuthor.map((item) => item.id), [event.id]);

  const byTag = store.query([normalizeFilter({ '#e': [targetId] })]);
  assert.deepEqual(byTag.map((item) => item.id), [event.id]);

  const bySince = store.query([normalizeFilter({ since: 600 })]);
  assert.deepEqual(bySince.map((item) => item.id), [other.id]);
});

test('可替换事件保留最新，同时间戳保留 id 较小者', () => {
  const { store } = createTestStore();
  const key = createTestKey();

  const older = createSignedEvent(key, { kind: 0, created_at: 100, content: 'old profile' });
  const newer = createSignedEvent(key, { kind: 0, created_at: 200, content: 'new profile' });

  assert.equal(store.save(older), 'stored');
  assert.equal(store.save(newer), 'stored');
  assert.deepEqual(
    store.query([normalizeFilter({ kinds: [0] })]).map((event) => event.id),
    [newer.id],
  );
  assert.equal(store.save(older), 'superseded');

  const { store: tieStore } = createTestStore();
  const tieA = createSignedEvent(key, { kind: 3, created_at: 300, content: 'a' });
  const tieB = createSignedEvent(key, { kind: 3, created_at: 300, content: 'b' });
  const smaller = tieA.id < tieB.id ? tieA : tieB;
  const larger = smaller === tieA ? tieB : tieA;

  assert.equal(tieStore.save(larger), 'stored');
  tieStore.save(smaller);
  assert.deepEqual(
    tieStore.query([normalizeFilter({ kinds: [3] })]).map((event) => event.id),
    [smaller.id],
  );
  assert.equal(tieStore.save(larger), 'superseded');
});

test('可寻址事件按 d 标签分别替换（NIP-33）', () => {
  const { store } = createTestStore();
  const key = createTestKey();

  const postA = createSignedEvent(key, { kind: 30000, created_at: 100, tags: [['d', 'a']] });
  const postB = createSignedEvent(key, { kind: 30000, created_at: 100, tags: [['d', 'b']] });
  const postANew = createSignedEvent(key, { kind: 30000, created_at: 200, tags: [['d', 'a']] });

  assert.equal(store.save(postA), 'stored');
  assert.equal(store.save(postB), 'stored');
  assert.equal(store.save(postANew), 'stored');

  const ids = store
    .query([normalizeFilter({ kinds: [30000] })])
    .map((event) => event.id)
    .sort();
  assert.deepEqual(ids, [postB.id, postANew.id].sort());
});

test('ephemeral 事件不落库', () => {
  const { store } = createTestStore();
  const event = createSignedEvent(createTestKey(), { kind: 20001 });

  assert.equal(store.save(event), 'ephemeral');
  assert.deepEqual(store.query([normalizeFilter({})]), []);
});

test('NIP-40 过期事件拒绝写入且查询时排除', () => {
  const { db, store } = createTestStore();
  const key = createTestKey();
  const now = Math.floor(Date.now() / 1000);

  const expired = createSignedEvent(key, { tags: [['expiration', String(now - 5)]] });
  assert.equal(store.save(expired), 'expired');
  assert.deepEqual(store.query([normalizeFilter({})]), []);

  const fresh = createSignedEvent(key, { tags: [['expiration', String(now + 3600)]] });
  assert.equal(store.save(fresh), 'stored');
  assert.equal(store.query([normalizeFilter({})]).length, 1);

  db.prepare('UPDATE events SET expires_at = ? WHERE id = ?').run(1, fresh.id);
  assert.deepEqual(store.query([normalizeFilter({})]), []);
});

test('NIP-09 按 e 标签删除并阻止重新入库', () => {
  const { store } = createTestStore();
  const author = createTestKey();
  const stranger = createTestKey();

  const target = createSignedEvent(author, { created_at: 1000, content: 'delete me' });
  store.save(target);

  const foreignDeletion = createSignedEvent(stranger, {
    kind: 5,
    created_at: 1001,
    tags: [['e', target.id]],
  });
  assert.equal(store.save(foreignDeletion), 'stored');
  assert.deepEqual(
    store.query([normalizeFilter({ ids: [target.id] })]).map((event) => event.id),
    [target.id],
  );

  const deletion = createSignedEvent(author, {
    kind: 5,
    created_at: 1002,
    tags: [['e', target.id]],
  });
  assert.equal(store.save(deletion), 'stored');
  assert.deepEqual(store.query([normalizeFilter({ ids: [target.id] })]), []);
  assert.equal(store.save(target), 'deleted');
});

test('NIP-09 按 a 标签删除可寻址事件并阻止旧版本重新入库', () => {
  const { store } = createTestStore();
  const author = createTestKey();

  const article = createSignedEvent(author, {
    kind: 30000,
    created_at: 1000,
    tags: [['d', 'post']],
  });
  store.save(article);

  const deletion = createSignedEvent(author, {
    kind: 5,
    created_at: 1000,
    tags: [['a', `30000:${author.pubkey}:post`]],
  });
  assert.equal(store.save(deletion), 'stored');
  assert.deepEqual(store.query([normalizeFilter({ kinds: [30000] })]), []);

  const olderVersion = createSignedEvent(author, {
    kind: 30000,
    created_at: 900,
    tags: [['d', 'post']],
  });
  assert.equal(store.save(olderVersion), 'deleted');

  const newerVersion = createSignedEvent(author, {
    kind: 30000,
    created_at: 1100,
    tags: [['d', 'post']],
  });
  assert.equal(store.save(newerVersion), 'stored');
});
