import { schnorr } from '@noble/curves/secp256k1.js';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import type { RelayConfig } from '../src/config/config.js';
import { computeEventId, type NostrEvent } from '../src/protocol/event.js';
import { MessageHandler } from '../src/relay/handler.js';
import { RelayServer } from '../src/relay/server.js';
import { EventStore } from '../src/storage/events.js';
import { initializeSchema } from '../src/storage/schema.js';
import { setLogLevel } from '../src/utils/logger.js';

setLogLevel('error');

export interface TestKey {
  secretKey: Uint8Array;
  pubkey: string;
}

export function createTestKey(): TestKey {
  const secretKey = schnorr.utils.randomSecretKey();
  return { secretKey, pubkey: Buffer.from(schnorr.getPublicKey(secretKey)).toString('hex') };
}

export interface SignedEventOptions {
  kind?: number;
  content?: string;
  tags?: string[][];
  created_at?: number;
}

export function createSignedEvent(key: TestKey, options: SignedEventOptions = {}): NostrEvent {
  const draft = {
    pubkey: key.pubkey,
    created_at: options.created_at ?? Math.floor(Date.now() / 1000),
    kind: options.kind ?? 1,
    content: options.content ?? '',
    tags: options.tags ?? [],
  };
  const id = computeEventId(draft);
  const sig = schnorr.sign(Buffer.from(id, 'hex'), key.secretKey);
  return { ...draft, id, sig: Buffer.from(sig).toString('hex') };
}

export interface TestStore {
  db: Database.Database;
  store: EventStore;
}

export function createTestStore(): TestStore {
  const db = new Database(':memory:');
  initializeSchema(db);
  return { db, store: new EventStore(db) };
}

export function createTestConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    database: ':memory:',
    logLevel: 'error',
    allowedPubkeys: [],
    requireAuth: false,
    ...overrides,
  };
}

export interface TestRelay {
  server: RelayServer;
  handler: MessageHandler;
  store: EventStore;
  db: Database.Database;
  url: string;
  stop(): Promise<void>;
}

export async function startTestRelay(config: RelayConfig = createTestConfig()): Promise<TestRelay> {
  const db = new Database(':memory:');
  initializeSchema(db);
  const store = new EventStore(db);
  const handler = new MessageHandler(store, config);
  const server = new RelayServer(config, handler);

  await server.start();
  const port = server.port;
  if (port === null) {
    await server.stop();
    db.close();
    throw new Error('Relay did not report a listening port');
  }

  return {
    server,
    handler,
    store,
    db,
    url: `ws://127.0.0.1:${port}`,
    async stop(): Promise<void> {
      await server.stop();
      db.close();
    },
  };
}

type ServerMessage = unknown[];

interface Waiter {
  predicate: (message: ServerMessage) => boolean;
  resolve: (message: ServerMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** 基于 ws 的测试客户端，按谓词从消息队列中取消息 */
export class TestClient {
  private readonly pending: ServerMessage[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;
  private closeReason: Error | null = null;

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (Array.isArray(parsed)) {
        this.push(parsed as ServerMessage);
      }
    });
    socket.on('close', (code, reason) => {
      this.closed = true;
      this.closeReason = new Error(`socket closed: ${code} ${reason.toString()}`);
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(this.closeReason);
      }
    });
    socket.on('error', (error) => {
      this.closed = true;
      this.closeReason = error instanceof Error ? error : new Error(String(error));
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url);
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (error) => reject(error));
    });
    return client;
  }

  send(payload: unknown): void {
    this.socket.send(JSON.stringify(payload));
  }

  sendRaw(text: string): void {
    this.socket.send(text);
  }

  next(predicate: (message: ServerMessage) => boolean = () => true, timeoutMs = 3000): Promise<ServerMessage> {
    const index = this.pending.findIndex(predicate);
    if (index >= 0) {
      const [message] = this.pending.splice(index, 1);
      return Promise.resolve(message as ServerMessage);
    }
    if (this.closed) {
      return Promise.reject(this.closeReason ?? new Error('socket closed'));
    }

    return new Promise<ServerMessage>((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const waiterIndex = this.waiters.indexOf(waiter);
          if (waiterIndex >= 0) {
            this.waiters.splice(waiterIndex, 1);
          }
          reject(new Error(`timed out waiting for message; pending=${JSON.stringify(this.pending)}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async expectNoMessage(predicate: (message: ServerMessage) => boolean, waitMs = 300): Promise<boolean> {
    try {
      await this.next(predicate, waitMs);
      return false;
    } catch {
      return true;
    }
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.close(1000, 'test done');
    });
  }

  private push(message: ServerMessage): void {
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
      return;
    }
    this.pending.push(message);
  }
}

export function isMessageType(message: ServerMessage, type: string): boolean {
  return message[0] === type;
}

export function isOkFor(message: ServerMessage, eventId: string): boolean {
  return message[0] === 'OK' && message[1] === eventId;
}

export function isEventFor(message: ServerMessage, subscriptionId: string): boolean {
  return message[0] === 'EVENT' && message[1] === subscriptionId;
}
