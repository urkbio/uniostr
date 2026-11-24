import type { NostrEvent } from './event.js';

/**
 * Nostr 协议消息的基础类型与识别逻辑。
 * 当前阶段只做结构识别，签名/过滤等语义在校验层与 handler 中处理。
 */

export type ClientMessageType = 'EVENT' | 'REQ' | 'CLOSE' | 'AUTH' | 'COUNT';

/** 客户端 -> Relay：发布事件 */
export interface EventClientMessage {
  type: 'EVENT';
  event: NostrEvent;
}

/** 客户端 -> Relay：建立订阅（Filter 解析与执行留待后续阶段） */
export interface ReqClientMessage {
  type: 'REQ';
  subscriptionId: string;
  filters: Record<string, unknown>[];
}

/** 客户端 -> Relay：关闭订阅 */
export interface CloseClientMessage {
  type: 'CLOSE';
  subscriptionId: string;
}

/** 客户端 -> Relay：NIP-42 认证事件（认证流程留待后续阶段） */
export interface AuthClientMessage {
  type: 'AUTH';
  event: NostrEvent;
}

/** 客户端 -> Relay：统计事件数量（统计逻辑留待后续阶段） */
export interface CountClientMessage {
  type: 'COUNT';
  subscriptionId: string;
  filters: Record<string, unknown>[];
}

export type ClientMessage =
  | EventClientMessage
  | ReqClientMessage
  | CloseClientMessage
  | AuthClientMessage
  | CountClientMessage;

export type ParseErrorCode = 'invalid-json' | 'invalid-structure' | 'unsupported-type';

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: ParseErrorCode; error: string };

function invalid(detail: string, code: ParseErrorCode = 'invalid-structure'): ParseResult {
  return { ok: false, code, error: detail };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseEvent(value: unknown): NostrEvent | string {
  if (!isPlainObject(value)) {
    return 'event 必须是 JSON 对象';
  }
  if (!isNonEmptyString(value.id)) {
    return 'event.id 必须是非空字符串';
  }
  if (!isNonEmptyString(value.pubkey)) {
    return 'event.pubkey 必须是非空字符串';
  }
  if (!isNonEmptyString(value.sig)) {
    return 'event.sig 必须是非空字符串';
  }
  if (typeof value.content !== 'string') {
    return 'event.content 必须是字符串';
  }
  if (typeof value.created_at !== 'number' || !Number.isInteger(value.created_at)) {
    return 'event.created_at 必须是整数时间戳';
  }
  if (typeof value.kind !== 'number' || !Number.isInteger(value.kind)) {
    return 'event.kind 必须是整数';
  }
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => Array.isArray(tag) && tag.every((v) => typeof v === 'string'))) {
    return 'event.tags 必须是字符串数组组成的数组';
  }

  return {
    id: value.id,
    pubkey: value.pubkey,
    created_at: value.created_at,
    kind: value.kind,
    content: value.content,
    tags: value.tags as string[][],
    sig: value.sig,
  };
}

function parseFilters(values: unknown[]): Record<string, unknown>[] | string {
  if (values.length === 0) {
    return '至少需要一个 filter';
  }
  if (!values.every(isPlainObject)) {
    return 'filter 必须是 JSON 对象';
  }
  return values;
}

function parseEventMessage(type: 'EVENT' | 'AUTH', args: unknown[]): ParseResult {
  const event = parseEvent(args[0]);
  if (typeof event === 'string') {
    return invalid(`${type} 消息无效：${event}`);
  }
  if (type === 'EVENT') {
    return { ok: true, message: { type: 'EVENT', event } };
  }
  return { ok: true, message: { type: 'AUTH', event } };
}

function parseSubscriptionMessage(type: 'REQ' | 'COUNT', args: unknown[]): ParseResult {
  const [subscriptionId, ...filterValues] = args;
  if (!isNonEmptyString(subscriptionId)) {
    return invalid(`${type} 消息缺少有效的 subscription id`);
  }
  const filters = parseFilters(filterValues);
  if (typeof filters === 'string') {
    return invalid(`${type} 消息无效：${filters}`);
  }
  if (type === 'REQ') {
    return { ok: true, message: { type: 'REQ', subscriptionId, filters } };
  }
  return { ok: true, message: { type: 'COUNT', subscriptionId, filters } };
}

/**
 * 解析一条客户端文本消息，返回识别到的消息类型或明确的错误。
 */
export function parseClientMessage(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return invalid(`消息不是合法的 JSON：${(error as Error).message}`, 'invalid-json');
  }

  if (!Array.isArray(data)) {
    return invalid('消息必须是 JSON 数组');
  }

  const [type, ...args] = data;
  if (typeof type !== 'string') {
    return invalid('消息的第一个元素必须是消息类型字符串');
  }

  switch (type) {
    case 'EVENT':
    case 'AUTH':
      return parseEventMessage(type, args);
    case 'REQ':
    case 'COUNT':
      return parseSubscriptionMessage(type, args);
    case 'CLOSE': {
      const [subscriptionId] = args;
      if (!isNonEmptyString(subscriptionId)) {
        return invalid('CLOSE 消息缺少有效的 subscription id');
      }
      return { ok: true, message: { type: 'CLOSE', subscriptionId } };
    }
    default:
      return invalid(`不支持的消息类型：${type}`, 'unsupported-type');
  }
}

/** Relay -> 客户端的消息 */
export type ServerMessage =
  | { type: 'EVENT'; subscriptionId: string; event: NostrEvent }
  | { type: 'EOSE'; subscriptionId: string }
  | { type: 'OK'; eventId: string; accepted: boolean; message: string }
  | { type: 'CLOSED'; subscriptionId: string; message: string }
  | { type: 'NOTICE'; message: string }
  | { type: 'AUTH'; challenge: string };

export function serializeServerMessage(message: ServerMessage): string {
  switch (message.type) {
    case 'EVENT':
      return JSON.stringify(['EVENT', message.subscriptionId, message.event]);
    case 'EOSE':
      return JSON.stringify(['EOSE', message.subscriptionId]);
    case 'OK':
      return JSON.stringify(['OK', message.eventId, message.accepted, message.message]);
    case 'CLOSED':
      return JSON.stringify(['CLOSED', message.subscriptionId, message.message]);
    case 'NOTICE':
      return JSON.stringify(['NOTICE', message.message]);
    case 'AUTH':
      return JSON.stringify(['AUTH', message.challenge]);
  }
}
