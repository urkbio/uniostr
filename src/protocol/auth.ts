import { getTagValue, verifyEvent, type NostrEvent } from './event.js';

export interface AuthVerifyOptions {
  challenge: string;
  relayUrl: string;
  now: number;
}

export type AuthVerifyResult = { ok: true; pubkey: string } | { ok: false; reason: string };

const AUTH_KIND = 22242;
const AUTH_MAX_AGE_SECONDS = 600;

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function relayUrlMatches(tagValue: string, relayUrl: string): boolean {
  if (normalizeUrl(tagValue) === normalizeUrl(relayUrl)) {
    return true;
  }
  try {
    const tagged = new URL(tagValue);
    const expected = new URL(relayUrl);
    return (
      tagged.host === expected.host && normalizeUrl(tagged.pathname) === normalizeUrl(expected.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * NIP-42：校验客户端 AUTH 事件（kind 22242）。
 * challenge 与 relay 标签必须匹配本次连接，时间窗口 ±10 分钟。
 */
export function verifyAuthEvent(event: NostrEvent, options: AuthVerifyOptions): AuthVerifyResult {
  if (event.kind !== AUTH_KIND) {
    return { ok: false, reason: 'invalid: auth event must be kind 22242' };
  }

  const verification = verifyEvent(event);
  if (!verification.ok) {
    return verification;
  }

  if (Math.abs(options.now - event.created_at) > AUTH_MAX_AGE_SECONDS) {
    return { ok: false, reason: 'invalid: auth event timestamp is out of range' };
  }

  if (getTagValue(event, 'challenge') !== options.challenge) {
    return { ok: false, reason: 'invalid: auth challenge mismatch' };
  }

  const relayTag = getTagValue(event, 'relay');
  if (relayTag === undefined || !relayUrlMatches(relayTag, options.relayUrl)) {
    return { ok: false, reason: 'invalid: auth relay mismatch' };
  }

  return { ok: true, pubkey: event.pubkey };
}
