import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeEventId,
  getDTag,
  getExpiration,
  isAddressableKind,
  isEphemeralKind,
  isExpired,
  isReplaceableKind,
  verifyEvent,
} from '../src/protocol/event.js';
import { createSignedEvent, createTestKey } from './helpers.js';

test('合法事件通过 ID 与签名校验', () => {
  const key = createTestKey();
  const event = createSignedEvent(key, { content: 'hello nostr', tags: [['t', 'nostr']] });

  assert.deepEqual(verifyEvent(event), { ok: true });
  assert.equal(computeEventId(event), event.id);
});

test('内容被篡改后 ID 校验失败', () => {
  const event = createSignedEvent(createTestKey(), { content: 'original' });
  const result = verifyEvent({ ...event, content: 'tampered' });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /^invalid: event id/);
  }
});

test('签名被篡改后校验失败', () => {
  const event = createSignedEvent(createTestKey());
  const lastChar = event.sig.endsWith('00') ? '01' : '00';
  const result = verifyEvent({ ...event, sig: `${event.sig.slice(0, -2)}${lastChar}` });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /^invalid: signature/);
  }
});

test('字段格式不合法的标签会被拒绝', () => {
  const event = createSignedEvent(createTestKey());

  assert.equal(verifyEvent({ ...event, id: event.id.toUpperCase() }).ok, false);
  assert.equal(verifyEvent({ ...event, pubkey: event.pubkey.slice(0, 63) }).ok, false);
  assert.equal(verifyEvent({ ...event, sig: event.sig.slice(0, 127) }).ok, false);
});

test('expiration 标签解析与过期判断', () => {
  const key = createTestKey();
  const now = Math.floor(Date.now() / 1000);

  const expired = createSignedEvent(key, { tags: [['expiration', String(now - 10)]] });
  const fresh = createSignedEvent(key, { tags: [['expiration', String(now + 3600)]] });
  const invalid = createSignedEvent(key, { tags: [['expiration', 'not-a-number']] });
  const none = createSignedEvent(key);

  assert.equal(getExpiration(expired), now - 10);
  assert.equal(isExpired(expired, now), true);
  assert.equal(isExpired(fresh, now), false);
  assert.equal(getExpiration(invalid), undefined);
  assert.equal(isExpired(invalid, now), false);
  assert.equal(getExpiration(none), undefined);
});

test('kind 分类与 d 标签提取', () => {
  assert.equal(isReplaceableKind(0), true);
  assert.equal(isReplaceableKind(3), true);
  assert.equal(isReplaceableKind(10000), true);
  assert.equal(isReplaceableKind(19999), true);
  assert.equal(isReplaceableKind(1), false);
  assert.equal(isReplaceableKind(20000), false);

  assert.equal(isEphemeralKind(20000), true);
  assert.equal(isEphemeralKind(29999), true);
  assert.equal(isEphemeralKind(19999), false);
  assert.equal(isEphemeralKind(30000), false);

  assert.equal(isAddressableKind(30000), true);
  assert.equal(isAddressableKind(39999), true);
  assert.equal(isAddressableKind(40000), false);

  const event = createSignedEvent(createTestKey(), { tags: [['d', 'my-article']] });
  assert.equal(getDTag(event), 'my-article');
  assert.equal(getDTag(createSignedEvent(createTestKey())), '');
});
