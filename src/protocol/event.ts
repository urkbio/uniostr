import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: string[][];
  sig: string;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

const EVENT_ID_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{128}$/;

export interface UnsignedEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: string[][];
}

/**
 * NIP-01 规定的事件 ID 序列化形式：[0, pubkey, created_at, kind, tags, content]
 */
export function serializeEvent(event: UnsignedEvent): string {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
}

/** 计算事件 ID（sha256 十六进制小写） */
export function computeEventId(event: UnsignedEvent): string {
  return createHash('sha256').update(serializeEvent(event), 'utf8').digest('hex');
}

/**
 * 校验事件 ID 与 schnorr 签名。只做密码学校验，结构校验由消息解析层负责。
 */
export function verifyEvent(event: NostrEvent): VerifyResult {
  if (!EVENT_ID_PATTERN.test(event.id)) {
    return { ok: false, reason: 'invalid: event id must be 64 hex characters' };
  }
  if (!EVENT_ID_PATTERN.test(event.pubkey)) {
    return { ok: false, reason: 'invalid: pubkey must be 64 hex characters' };
  }
  if (!SIGNATURE_PATTERN.test(event.sig)) {
    return { ok: false, reason: 'invalid: signature must be 128 hex characters' };
  }

  const expectedId = computeEventId(event);
  if (expectedId !== event.id) {
    return { ok: false, reason: 'invalid: event id does not match its content' };
  }

  try {
    const valid = schnorr.verify(
      Buffer.from(event.sig, 'hex'),
      Buffer.from(expectedId, 'hex'),
      Buffer.from(event.pubkey, 'hex'),
    );
    if (!valid) {
      return { ok: false, reason: 'invalid: signature verification failed' };
    }
  } catch {
    return { ok: false, reason: 'invalid: signature verification failed' };
  }

  return { ok: true };
}

/** 取第一个同名标签的第二个元素 */
export function getTagValue(event: NostrEvent, name: string): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] === name && tag.length > 1) {
      return tag[1];
    }
  }
  return undefined;
}

/** NIP-40：解析 expiration 标签（Unix 秒），非法值视为未设置 */
export function getExpiration(event: NostrEvent): number | undefined {
  const value = getTagValue(event, 'expiration');
  if (value === undefined) {
    return undefined;
  }
  const timestamp = Number(value);
  return Number.isInteger(timestamp) && timestamp >= 0 ? timestamp : undefined;
}

export function isExpired(event: NostrEvent, now: number): boolean {
  const expiration = getExpiration(event);
  return expiration !== undefined && expiration <= now;
}

/** NIP-33：addressable 事件的 d 标签值，缺省为空字符串 */
export function getDTag(event: NostrEvent): string {
  return getTagValue(event, 'd') ?? '';
}

/** kind 0、3 与 10000-19999 为可替换事件 */
export function isReplaceableKind(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

/** kind 20000-29999 为临时事件，不落库 */
export function isEphemeralKind(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

/** kind 30000-39999 为可寻址事件（NIP-33） */
export function isAddressableKind(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}
