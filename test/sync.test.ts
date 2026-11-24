import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFilter } from '../src/protocol/filter.js';
import { RemoteSync } from '../src/relay/remote-sync.js';
import { SyncStateStore } from '../src/storage/sync-state.js';
import {
  createSignedEvent,
  createTestConfig,
  createTestKey,
  createTestStore,
  startTestRelay,
  TestClient,
} from './helpers.js';

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('waitFor 超时');
}

test('远端同步只拉取白名单作者并去重入库', async (t) => {
  const source = await startTestRelay();
  const allowed = createTestKey();
  const stranger = createTestKey();

  const allowedClient = await TestClient.connect(source.url);
  const strangerClient = await TestClient.connect(source.url);
  t.after(async () => {
    await allowedClient.close();
    await strangerClient.close();
    await source.stop();
  });

  const allowedEvent = createSignedEvent(allowed, { content: 'allowed', created_at: 1000 });
  const strangerEvent = createSignedEvent(stranger, { content: 'stranger', created_at: 1001 });
  allowedClient.send(['EVENT', allowedEvent]);
  await allowedClient.next((message) => message[0] === 'OK' && message[1] === allowedEvent.id);
  strangerClient.send(['EVENT', strangerEvent]);
  await strangerClient.next((message) => message[0] === 'OK' && message[1] === strangerEvent.id);

  const target = createTestStore();
  const config = createTestConfig({ remoteRelay: source.url, allowedPubkeys: [allowed.pubkey] });
  const sync = new RemoteSync(config, target.store, new SyncStateStore(target.db), {
    pollIntervalMs: 100,
    reconnectDelayMs: 100,
  });
  t.after(() => {
    sync.stop();
    target.db.close();
  });

  sync.start();

  await waitFor(() =>
    target.store.query([normalizeFilter({})]).some((event) => event.id === allowedEvent.id),
  );

  const initial = target.store.query([normalizeFilter({})]);
  assert.equal(initial.some((event) => event.id === strangerEvent.id), false);
  assert.equal(initial.filter((event) => event.id === allowedEvent.id).length, 1);

  const liveEvent = createSignedEvent(allowed, { content: 'live' });
  allowedClient.send(['EVENT', liveEvent]);
  await allowedClient.next((message) => message[0] === 'OK' && message[1] === liveEvent.id);
  await waitFor(() => target.store.query([normalizeFilter({ ids: [liveEvent.id] })]).length === 1);

  const strangerLive = createSignedEvent(stranger, { content: 'stranger live' });
  strangerClient.send(['EVENT', strangerLive]);
  await strangerClient.next((message) => message[0] === 'OK' && message[1] === strangerLive.id);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(target.store.query([normalizeFilter({ ids: [strangerLive.id] })]).length, 0);

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(target.store.query([normalizeFilter({ ids: [allowedEvent.id] })]).length, 1);
});

test('分页回溯全部历史并持久化同步状态', async (t) => {
  const source = await startTestRelay();
  const author = createTestKey();
  const client = await TestClient.connect(source.url);
  t.after(async () => {
    await client.close();
    await source.stop();
  });

  const events = Array.from({ length: 5 }, (_, index) =>
    createSignedEvent(author, { created_at: 1000 + index, content: `post ${index}` }),
  );
  for (const event of events) {
    client.send(['EVENT', event]);
    await client.next((message) => message[0] === 'OK' && message[1] === event.id);
  }

  const target = createTestStore();
  const stateStore = new SyncStateStore(target.db);
  const config = createTestConfig({ remoteRelay: source.url, allowedPubkeys: [author.pubkey] });
  const sync = new RemoteSync(config, target.store, stateStore, {
    pageSize: 2,
    pollIntervalMs: 100,
    reconnectDelayMs: 100,
  });
  t.after(() => {
    sync.stop();
    target.db.close();
  });

  sync.start();

  await waitFor(() => target.store.query([normalizeFilter({})]).length === 5);

  const state = stateStore.get(source.url);
  assert.equal(state?.backfillComplete, true);
  assert.equal(state?.backfillCursor, null);
  assert.equal(state?.lastSeen, 1004);

  const liveEvent = createSignedEvent(author, { content: 'after backfill' });
  client.send(['EVENT', liveEvent]);
  await client.next((message) => message[0] === 'OK' && message[1] === liveEvent.id);
  await waitFor(() => target.store.query([normalizeFilter({ ids: [liveEvent.id] })]).length === 1);
});

test('未配置 remoteRelay 或白名单为空时不同步', async (t) => {
  const target = createTestStore();
  t.after(() => target.db.close());

  const stateStore = new SyncStateStore(target.db);

  const disabled = new RemoteSync(createTestConfig(), target.store, stateStore, { pollIntervalMs: 50 });
  disabled.start();
  disabled.stop();

  const withoutAuthors = new RemoteSync(
    createTestConfig({ remoteRelay: 'ws://127.0.0.1:1' }),
    target.store,
    stateStore,
    { pollIntervalMs: 50 },
  );
  withoutAuthors.start();
  withoutAuthors.stop();

  assert.deepEqual(target.store.query([normalizeFilter({})]), []);
});
