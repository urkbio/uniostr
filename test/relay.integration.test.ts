import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NostrEvent } from '../src/protocol/event.js';
import {
  createSignedEvent,
  createTestConfig,
  createTestKey,
  isEventFor,
  isMessageType,
  isOkFor,
  startTestRelay,
  TestClient,
} from './helpers.js';

async function takeChallenge(client: TestClient): Promise<string> {
  const message = await client.next((item) => isMessageType(item, 'AUTH'));
  const challenge = message[1];
  assert.equal(typeof challenge, 'string');
  return challenge as string;
}

function eventFrom(message: unknown[]): NostrEvent {
  return message[2] as NostrEvent;
}

test('事件发布、历史查询、实时推送与 CLOSE', async (t) => {
  const relay = await startTestRelay();
  const key = createTestKey();
  const clientA = await TestClient.connect(relay.url);
  const clientB = await TestClient.connect(relay.url);
  t.after(async () => {
    await clientA.close();
    await clientB.close();
    await relay.stop();
  });

  await takeChallenge(clientA);
  await takeChallenge(clientB);

  const historyEvent = createSignedEvent(key, { content: 'history', created_at: 1000 });
  clientA.send(['EVENT', historyEvent]);
  const storedOk = await clientA.next((message) => isOkFor(message, historyEvent.id));
  assert.deepEqual(storedOk, ['OK', historyEvent.id, true, '']);

  clientB.send(['REQ', 'sub-history', { kinds: [1], limit: 10 }]);
  const historyMessage = await clientB.next((message) => isEventFor(message, 'sub-history'));
  assert.equal(eventFrom(historyMessage).id, historyEvent.id);
  const eose = await clientB.next((message) => isMessageType(message, 'EOSE'));
  assert.deepEqual(eose, ['EOSE', 'sub-history']);

  const liveEvent = createSignedEvent(key, { content: 'live', created_at: 1001 });
  clientA.send(['EVENT', liveEvent]);
  await clientA.next((message) => isOkFor(message, liveEvent.id));
  const liveMessage = await clientB.next((message) => isEventFor(message, 'sub-history'));
  assert.equal(eventFrom(liveMessage).id, liveEvent.id);

  clientB.send(['CLOSE', 'sub-history']);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const afterClose = createSignedEvent(key, { content: 'after close', created_at: 1002 });
  clientA.send(['EVENT', afterClose]);
  await clientA.next((message) => isOkFor(message, afterClose.id));
  assert.equal(
    await clientB.expectNoMessage((message) => isEventFor(message, 'sub-history'), 300),
    true,
  );

  clientB.send(['REQ', 'sub-again', { ids: [historyEvent.id] }]);
  const byId = await clientB.next((message) => isEventFor(message, 'sub-again'));
  assert.equal(eventFrom(byId).id, historyEvent.id);
});

test('重复事件、坏签名、非法 filter 与坏消息的响应', async (t) => {
  const relay = await startTestRelay();
  const key = createTestKey();
  const client = await TestClient.connect(relay.url);
  t.after(async () => {
    await client.close();
    await relay.stop();
  });

  await takeChallenge(client);

  const event = createSignedEvent(key, { content: 'plain' });
  client.send(['EVENT', event]);
  await client.next((message) => isOkFor(message, event.id));

  client.send(['EVENT', event]);
  const duplicate = await client.next((message) => isOkFor(message, event.id));
  assert.equal(duplicate[2], true);
  assert.match(String(duplicate[3]), /^duplicate:/);

  const tampered = createSignedEvent(key, { content: 'tampered' });
  const lastChar = tampered.sig.endsWith('00') ? '01' : '00';
  client.send(['EVENT', { ...tampered, sig: `${tampered.sig.slice(0, -2)}${lastChar}` }]);
  const rejected = await client.next((message) => isOkFor(message, tampered.id));
  assert.equal(rejected[2], false);
  assert.match(String(rejected[3]), /^invalid:/);

  client.send(['REQ', 'bad-filter', { kinds: 'nope' }]);
  const closed = await client.next((message) => isMessageType(message, 'CLOSED'));
  assert.deepEqual(closed[0], 'CLOSED');
  assert.equal(closed[1], 'bad-filter');
  assert.match(String(closed[2]), /^invalid:/);

  client.sendRaw('{not json');
  const notice = await client.next((message) => isMessageType(message, 'NOTICE'));
  assert.match(String(notice[1]), /JSON/);

  client.send(['COUNT', 'count-sub', {}]);
  const countNotice = await client.next((message) => isMessageType(message, 'NOTICE'));
  assert.match(String(countNotice[1]), /COUNT/);
});

test('requireAuth 要求 NIP-42 认证后才能读写', async (t) => {
  const relay = await startTestRelay(createTestConfig({ requireAuth: true }));
  const key = createTestKey();
  const client = await TestClient.connect(relay.url);
  t.after(async () => {
    await client.close();
    await relay.stop();
  });

  const challenge = await takeChallenge(client);

  client.send(['REQ', 'before-auth', { kinds: [1] }]);
  const refused = await client.next((message) => isMessageType(message, 'CLOSED'));
  assert.match(String(refused[2]), /^auth-required:/);

  const event = createSignedEvent(key, { content: 'blocked before auth' });
  client.send(['EVENT', event]);
  const refusedEvent = await client.next((message) => isOkFor(message, event.id));
  assert.equal(refusedEvent[2], false);
  assert.match(String(refusedEvent[3]), /^auth-required:/);

  const wrongAuth = createSignedEvent(key, {
    kind: 22242,
    tags: [
      ['relay', relay.url],
      ['challenge', 'wrong-challenge'],
    ],
  });
  client.send(['AUTH', wrongAuth]);
  const wrongResult = await client.next((message) => isOkFor(message, wrongAuth.id));
  assert.equal(wrongResult[2], false);
  assert.match(String(wrongResult[3]), /^invalid:/);

  const authEvent = createSignedEvent(key, {
    kind: 22242,
    tags: [
      ['relay', relay.url],
      ['challenge', challenge],
    ],
  });
  client.send(['AUTH', authEvent]);
  const authOk = await client.next((message) => isOkFor(message, authEvent.id));
  assert.deepEqual(authOk, ['OK', authEvent.id, true, '']);

  client.send(['REQ', 'after-auth', { kinds: [1] }]);
  const eose = await client.next((message) => isMessageType(message, 'EOSE'));
  assert.equal(eose[1], 'after-auth');
});

test('白名单限制写入公钥', async (t) => {
  const allowed = createTestKey();
  const stranger = createTestKey();
  const relay = await startTestRelay(createTestConfig({ allowedPubkeys: [allowed.pubkey] }));
  const client = await TestClient.connect(relay.url);
  t.after(async () => {
    await client.close();
    await relay.stop();
  });

  await takeChallenge(client);

  const allowedEvent = createSignedEvent(allowed, { content: 'allowed' });
  client.send(['EVENT', allowedEvent]);
  const accepted = await client.next((message) => isOkFor(message, allowedEvent.id));
  assert.equal(accepted[2], true);

  const strangerEvent = createSignedEvent(stranger, { content: 'stranger' });
  client.send(['EVENT', strangerEvent]);
  const blocked = await client.next((message) => isOkFor(message, strangerEvent.id));
  assert.equal(blocked[2], false);
  assert.match(String(blocked[3]), /^blocked:/);
});
