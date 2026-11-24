import { randomBytes } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
import type { RelayConfig } from '../config/config.js';
import { verifyAuthEvent } from '../protocol/auth.js';
import { isExpired, verifyEvent, type NostrEvent } from '../protocol/event.js';
import { FilterError, matchesAnyFilter, normalizeFilters, type NostrFilter } from '../protocol/filter.js';
import { parseClientMessage, serializeServerMessage, type ServerMessage } from '../protocol/message.js';
import type { EventStore } from '../storage/events.js';
import { logger } from '../utils/logger.js';

const ID_PREVIEW_LENGTH = 16;

/** server 只依赖这些方法，协议处理的具体实现由 handler 提供 */
export interface RelayConnectionHandler {
  setRelayUrl(url: string): void;
  handleOpen(socket: WebSocket): void;
  handleMessage(socket: WebSocket, data: RawData, isBinary: boolean): void;
  handleClose(socket: WebSocket): void;
}

interface Session {
  challenge: string;
  pubkey: string | null;
  subscriptions: Map<string, NostrFilter[]>;
}

function preview(value: string): string {
  return value.length <= ID_PREVIEW_LENGTH ? value : `${value.slice(0, ID_PREVIEW_LENGTH)}...`;
}

function toText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}

/**
 * Nostr 协议处理：事件校验/入库、REQ 查询与订阅、实时推送、AUTH 与白名单。
 * 网络连接生命周期由 RelayServer 触发，本类不直接管理 HTTP/WS 服务。
 */
export class MessageHandler implements RelayConnectionHandler {
  private readonly sessions = new Map<WebSocket, Session>();
  private relayUrl: string;

  constructor(
    private readonly store: EventStore,
    private readonly config: RelayConfig,
  ) {
    this.relayUrl = `ws://${config.host}:${config.port}`;
  }

  setRelayUrl(url: string): void {
    this.relayUrl = url.replace(/\/+$/, '');
  }

  handleOpen(socket: WebSocket): void {
    const session: Session = {
      challenge: randomBytes(16).toString('hex'),
      pubkey: null,
      subscriptions: new Map(),
    };
    this.sessions.set(socket, session);
    this.send(socket, { type: 'AUTH', challenge: session.challenge });
  }

  handleClose(socket: WebSocket): void {
    this.sessions.delete(socket);
  }

  handleMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
    const session = this.sessions.get(socket);
    if (!session) {
      return;
    }

    if (isBinary) {
      logger.warn('收到不支持的二进制消息');
      this.notice(socket, 'unsupported: only text frames are accepted');
      return;
    }

    const result = parseClientMessage(toText(data));
    if (!result.ok) {
      logger.warn('无法解析客户端消息', { code: result.code, reason: result.error });
      this.notice(socket, result.error);
      return;
    }

    switch (result.message.type) {
      case 'EVENT':
        this.handleEvent(socket, session, result.message.event);
        break;
      case 'REQ':
        this.handleReq(socket, session, result.message.subscriptionId, result.message.filters);
        break;
      case 'CLOSE':
        session.subscriptions.delete(result.message.subscriptionId);
        logger.debug('已关闭订阅', { subscriptionId: preview(result.message.subscriptionId) });
        break;
      case 'AUTH':
        this.handleAuth(socket, session, result.message.event);
        break;
      case 'COUNT':
        this.notice(socket, 'unsupported: COUNT is not implemented');
        break;
    }
  }

  private handleEvent(socket: WebSocket, session: Session, event: NostrEvent): void {
    const accessError = this.checkWriteAccess(session, event.pubkey);
    if (accessError) {
      this.sendOk(socket, event.id, false, accessError);
      return;
    }

    const verification = verifyEvent(event);
    if (!verification.ok) {
      logger.warn('事件校验失败', { eventId: preview(event.id), reason: verification.reason });
      this.sendOk(socket, event.id, false, verification.reason);
      return;
    }

    let result;
    try {
      result = this.store.save(event);
    } catch (error) {
      logger.error('事件入库失败', { eventId: preview(event.id), error });
      this.sendOk(socket, event.id, false, 'error: internal error');
      return;
    }

    switch (result) {
      case 'stored':
      case 'ephemeral':
        logger.info('事件已接收', { eventId: preview(event.id), kind: event.kind });
        this.sendOk(socket, event.id, true, '');
        if (!isExpired(event, Math.floor(Date.now() / 1000))) {
          this.broadcast(event);
        }
        break;
      case 'duplicate':
        this.sendOk(socket, event.id, true, 'duplicate: already have this event');
        break;
      case 'superseded':
        this.sendOk(socket, event.id, true, 'duplicate: newer version exists');
        break;
      case 'expired':
        this.sendOk(socket, event.id, false, 'invalid: event has expired');
        break;
      case 'deleted':
        this.sendOk(socket, event.id, false, 'blocked: event has been deleted');
        break;
    }
  }

  private handleReq(
    socket: WebSocket,
    session: Session,
    subscriptionId: string,
    rawFilters: Record<string, unknown>[],
  ): void {
    if (this.config.requireAuth && session.pubkey === null) {
      this.sendClosed(socket, subscriptionId, 'auth-required: authentication required');
      return;
    }

    let filters: NostrFilter[];
    try {
      filters = normalizeFilters(rawFilters);
    } catch (error) {
      const reason = error instanceof FilterError ? error.message : 'invalid filter';
      logger.warn('订阅 filter 非法', { subscriptionId: preview(subscriptionId), reason });
      this.sendClosed(socket, subscriptionId, `invalid: ${reason}`);
      return;
    }

    let events: NostrEvent[];
    try {
      events = this.store.query(filters);
    } catch (error) {
      logger.error('订阅查询失败', { subscriptionId: preview(subscriptionId), error });
      this.sendClosed(socket, subscriptionId, 'error: query failed');
      return;
    }

    for (const event of events) {
      this.send(socket, { type: 'EVENT', subscriptionId, event });
    }
    this.send(socket, { type: 'EOSE', subscriptionId });
    session.subscriptions.set(subscriptionId, filters);
    logger.info('订阅已建立', {
      subscriptionId: preview(subscriptionId),
      filters: filters.length,
      events: events.length,
    });
  }

  private handleAuth(socket: WebSocket, session: Session, event: NostrEvent): void {
    if (this.config.allowedPubkeys.length > 0 && !this.config.allowedPubkeys.includes(event.pubkey)) {
      this.sendOk(socket, event.id, false, 'blocked: pubkey is not in the whitelist');
      return;
    }

    const result = verifyAuthEvent(event, {
      challenge: session.challenge,
      relayUrl: this.relayUrl,
      now: Math.floor(Date.now() / 1000),
    });

    if (!result.ok) {
      logger.warn('AUTH 校验失败', { reason: result.reason });
      this.sendOk(socket, event.id, false, result.reason);
      return;
    }

    session.pubkey = result.pubkey;
    logger.info('客户端认证成功', { pubkey: preview(result.pubkey) });
    this.sendOk(socket, event.id, true, '');
  }

  private checkWriteAccess(session: Session, pubkey: string): string | null {
    if (this.config.requireAuth && session.pubkey === null) {
      return 'auth-required: authentication required';
    }
    if (this.config.allowedPubkeys.length > 0 && !this.config.allowedPubkeys.includes(pubkey)) {
      return 'blocked: pubkey is not in the whitelist';
    }
    return null;
  }

  private broadcast(event: NostrEvent): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [socket, session] of this.sessions) {
      for (const [subscriptionId, filters] of session.subscriptions) {
        if (matchesAnyFilter(event, filters, now)) {
          this.send(socket, { type: 'EVENT', subscriptionId, event });
        }
      }
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    try {
      socket.send(serializeServerMessage(message));
    } catch (error) {
      logger.warn('发送消息失败', { error });
    }
  }

  private sendOk(socket: WebSocket, eventId: string, accepted: boolean, message: string): void {
    this.send(socket, { type: 'OK', eventId, accepted, message });
  }

  private sendClosed(socket: WebSocket, subscriptionId: string, message: string): void {
    this.send(socket, { type: 'CLOSED', subscriptionId, message });
  }

  private notice(socket: WebSocket, message: string): void {
    this.send(socket, { type: 'NOTICE', message });
  }
}
