import WebSocket, { type RawData } from 'ws';
import type { RelayConfig } from '../config/config.js';
import { verifyEvent, type NostrEvent } from '../protocol/event.js';
import { parseEventObject } from '../protocol/message.js';
import type { EventStore } from '../storage/events.js';
import type { SyncStateStore } from '../storage/sync-state.js';
import { logger } from '../utils/logger.js';

const LIVE_SUBSCRIPTION_ID = 'uniostr-sync';
const BACKFILL_SUBSCRIPTION_ID = 'uniostr-sync-backfill';
const DEFAULT_PAGE_SIZE = 500;
const SYNC_OVERLAP_SECONDS = 300;
const LIVE_WARMUP_SECONDS = 60;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_RECONNECT_DELAY_MS = 5_000;
const ID_PREVIEW_LENGTH = 16;

export interface RemoteSyncOptions {
  pollIntervalMs?: number;
  reconnectDelayMs?: number;
  /** 历史回溯分页大小，同时作为每次 REQ 的 limit */
  pageSize?: number;
}

interface SyncStats {
  received: number;
  stored: number;
  duplicate: number;
  rejected: number;
}

function preview(value: string): string {
  return value.length <= ID_PREVIEW_LENGTH ? value : `${value.slice(0, ID_PREVIEW_LENGTH)}...`;
}

/**
 * 从配置的远端公开 Relay 单向拉取 allowedPubkeys 作者的全部事件：
 * - 一路订阅接收实时事件；
 * - 一路按 until 游标分页回溯完整历史，进度写入 sync_state，重启后续传；
 * - 每条事件重新做结构校验、白名单过滤、ID/签名验证，再交给 EventStore 去重入库。
 */
export class RemoteSync {
  private socket: WebSocket | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  private lastSeen = 0;
  private backfillActive = false;
  private backfillCursor: number | null = null;
  private batchCount = 0;
  private batchOldest: number | null = null;

  private readonly stats: SyncStats = { received: 0, stored: 0, duplicate: 0, rejected: 0 };
  private readonly pageSize: number;

  constructor(
    private readonly config: RelayConfig,
    private readonly store: EventStore,
    private readonly stateStore: SyncStateStore,
    private readonly options: RemoteSyncOptions = {},
  ) {
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  start(): void {
    if (this.config.remoteRelay === '') {
      logger.info('远端同步未启用');
      return;
    }
    if (this.config.allowedPubkeys.length === 0) {
      logger.warn('已配置 remoteRelay 但 allowedPubkeys 为空，跳过远端同步');
      return;
    }

    const state = this.stateStore.get(this.config.remoteRelay);
    this.lastSeen = state?.lastSeen ?? 0;
    this.backfillActive = state ? !state.backfillComplete : true;
    this.backfillCursor = state?.backfillCursor ?? null;
    this.stopped = false;

    logger.info('远端同步已启用', {
      relay: this.config.remoteRelay,
      authors: this.config.allowedPubkeys.length,
      backfill: this.backfillActive,
    });
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.persistState();
    this.clearTimers();

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      try {
        socket.close(1000, 'sync stopped');
      } catch {
        socket.terminate();
      }
    }

    logger.info('远端同步已停止', { ...this.stats });
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }

    const socket = new WebSocket(this.config.remoteRelay, {
      handshakeTimeout: 10_000,
      maxPayload: 1024 * 1024,
    });
    this.socket = socket;

    socket.on('open', () => {
      logger.info('远端同步已连接', { relay: this.config.remoteRelay });
      this.requestLive();
      if (this.backfillActive) {
        this.requestBackfill();
      }
      this.startPolling();
    });

    socket.on('message', (data) => {
      this.handleMessage(data);
    });

    socket.on('error', (error) => {
      logger.warn('远端同步连接异常', { relay: this.config.remoteRelay, error });
    });

    socket.on('close', (code, reason) => {
      if (this.socket === socket) {
        this.socket = null;
      }
      logger.warn('远端同步连接已断开', {
        relay: this.config.remoteRelay,
        code,
        reason: reason.toString() || undefined,
      });
      this.scheduleReconnect();
    });
  }

  private requestLive(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const since =
      this.lastSeen > 0
        ? Math.max(0, this.lastSeen - SYNC_OVERLAP_SECONDS)
        : Math.floor(Date.now() / 1000) - LIVE_WARMUP_SECONDS;

    const filter: Record<string, unknown> = {
      authors: this.config.allowedPubkeys,
      since,
      limit: this.pageSize,
    };
    socket.send(JSON.stringify(['REQ', LIVE_SUBSCRIPTION_ID, filter]));
    logger.debug('已发送实时同步 REQ', { since });
  }

  private requestBackfill(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.batchCount = 0;
    this.batchOldest = null;

    const filter: Record<string, unknown> = {
      authors: this.config.allowedPubkeys,
      limit: this.pageSize,
    };
    if (this.backfillCursor !== null) {
      filter.until = this.backfillCursor;
    }

    socket.send(JSON.stringify(['REQ', BACKFILL_SUBSCRIPTION_ID, filter]));
    logger.debug('已发送历史回溯 REQ', { until: this.backfillCursor ?? 'newest' });
  }

  private handleMessage(data: RawData): void {
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!Array.isArray(message)) {
      return;
    }

    const [type, subscriptionId] = message;
    const isSyncSubscription =
      subscriptionId === LIVE_SUBSCRIPTION_ID || subscriptionId === BACKFILL_SUBSCRIPTION_ID;

    if (type === 'EVENT' && isSyncSubscription) {
      const event = parseEventObject(message[2]);
      if (typeof event === 'string') {
        this.stats.rejected += 1;
        logger.warn('远端事件结构非法', { reason: event });
        return;
      }
      if (subscriptionId === BACKFILL_SUBSCRIPTION_ID) {
        this.batchCount += 1;
        this.batchOldest =
          this.batchOldest === null ? event.created_at : Math.min(this.batchOldest, event.created_at);
      }
      this.ingest(event);
      return;
    }

    if (type === 'EOSE' && subscriptionId === BACKFILL_SUBSCRIPTION_ID) {
      this.handleBackfillEose();
      return;
    }

    if (type === 'EOSE' && subscriptionId === LIVE_SUBSCRIPTION_ID) {
      logger.debug('远端同步本轮拉取完成', { ...this.stats });
      this.persistState();
      return;
    }

    if (type === 'CLOSED' && isSyncSubscription) {
      logger.warn('远端关闭了同步订阅', { reason: String(message[2] ?? '') });
      return;
    }

    if (type === 'NOTICE') {
      logger.debug('远端 NOTICE', { message: String(message[1] ?? '') });
      return;
    }

    if (type === 'AUTH') {
      logger.debug('远端要求 AUTH，只读同步忽略该请求');
    }
  }

  private handleBackfillEose(): void {
    if (!this.backfillActive) {
      return;
    }

    const received = this.batchCount;
    const oldest = this.batchOldest;
    this.batchCount = 0;
    this.batchOldest = null;

    if (received === 0 || oldest === null || received < this.pageSize || oldest <= 0) {
      this.finishBackfill();
      return;
    }

    this.backfillCursor = oldest - 1;
    this.persistState();
    logger.debug('历史回溯继续', { cursor: this.backfillCursor, received });
    this.requestBackfill();
  }

  private finishBackfill(): void {
    this.backfillActive = false;
    this.backfillCursor = null;
    this.persistState();
    logger.info('远端历史回溯完成', { ...this.stats });
  }

  private ingest(event: NostrEvent): void {
    this.stats.received += 1;

    if (!this.config.allowedPubkeys.includes(event.pubkey)) {
      this.stats.rejected += 1;
      return;
    }

    const verification = verifyEvent(event);
    if (!verification.ok) {
      this.stats.rejected += 1;
      logger.warn('远端事件校验失败', { eventId: preview(event.id), reason: verification.reason });
      return;
    }

    this.lastSeen = Math.max(this.lastSeen, event.created_at);

    let result;
    try {
      result = this.store.save(event);
    } catch (error) {
      logger.error('远端事件入库失败', { eventId: preview(event.id), error });
      return;
    }

    if (result === 'stored') {
      this.stats.stored += 1;
      logger.debug('远端事件已入库', { eventId: preview(event.id), kind: event.kind });
    } else if (result === 'duplicate') {
      this.stats.duplicate += 1;
    } else if (result !== 'ephemeral' && result !== 'superseded') {
      logger.debug('远端事件未入库', { eventId: preview(event.id), result });
    }
  }

  private persistState(): void {
    try {
      this.stateStore.save(this.config.remoteRelay, {
        backfillComplete: !this.backfillActive,
        backfillCursor: this.backfillActive ? this.backfillCursor : null,
        lastSeen: this.lastSeen,
      });
    } catch (error) {
      logger.warn('保存远端同步状态失败', { error });
    }
  }

  private startPolling(): void {
    this.stopPolling();
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollTimer = setInterval(() => {
      this.requestLive();
    }, interval);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.stopPolling();
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    const delay = this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    logger.info('将在稍后重连远端同步', { delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    this.stopPolling();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
