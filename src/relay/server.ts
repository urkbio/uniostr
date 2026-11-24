import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { RelayConfig } from '../config/config.js';
import { logger } from '../utils/logger.js';
import { handleClientMessage } from './handler.js';

const MAX_WS_PAYLOAD_BYTES = 512 * 1024;

/**
 * Relay 网络层：只负责 HTTP / WebSocket 的建立、连接管理与关闭，
 * 消息内容交由 handler 处理。
 */
export class RelayServer {
  private readonly config: RelayConfig;
  private readonly startedAt = Date.now();

  private httpServer: Server | null = null;
  private wsServer: WebSocketServer | null = null;

  constructor(config: RelayConfig) {
    this.config = config;
  }

  get address(): string {
    return `${this.config.host}:${this.config.port}`;
  }

  async start(): Promise<void> {
    if (this.httpServer) {
      throw new Error('Relay 服务已启动，不能重复启动');
    }

    const httpServer = createServer((request, response) => this.handleHttpRequest(request, response));
    const wsServer = new WebSocketServer({ server: httpServer, maxPayload: MAX_WS_PAYLOAD_BYTES });

    wsServer.on('connection', (socket, request) => this.handleConnection(socket, request));
    wsServer.on('error', (error) => logger.error('Relay 网络服务异常', { error }));

    this.httpServer = httpServer;
    this.wsServer = wsServer;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(this.config.port, this.config.host);
      });
    } catch (error) {
      await this.stop();
      throw error;
    }

    logger.info('Relay 服务已监听', {
      http: `http://${this.address}/`,
      ws: `ws://${this.address}/`,
    });
  }

  async stop(): Promise<void> {
    const wsServer = this.wsServer;
    const httpServer = this.httpServer;
    this.wsServer = null;
    this.httpServer = null;

    if (wsServer) {
      for (const client of wsServer.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        wsServer.close(() => resolve());
      });
    }

    if (httpServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
        httpServer.closeAllConnections();
      });
    }

    if (wsServer || httpServer) {
      logger.info('Relay 服务已关闭');
    }
  }

  private handleHttpRequest(request: IncomingMessage, response: ServerResponse): void {
    const pathname = (request.url ?? '/').split('?')[0];

    if (request.method !== 'GET') {
      this.respondJson(response, 405, { error: 'method not allowed' });
      return;
    }

    if (pathname === '/' || pathname === '/health') {
      this.respondJson(response, 200, {
        name: 'uniostr',
        status: 'ok',
        uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
        connections: this.wsServer?.clients.size ?? 0,
      });
      return;
    }

    this.respondJson(response, 404, { error: 'not found' });
  }

  private respondJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
    const payload = `${JSON.stringify(body)}\n`;
    response.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    });
    response.end(payload);
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const remote = request.socket.remoteAddress ?? 'unknown';
    logger.info('WebSocket 客户端已连接', { remote, clients: this.wsServer?.clients.size ?? 1 });

    socket.on('message', (data, isBinary) => {
      try {
        handleClientMessage(socket, data, isBinary);
      } catch (error) {
        logger.error('处理客户端消息时发生异常', { remote, error });
        socket.close(1011, 'internal error');
      }
    });

    socket.on('close', (code, reason) => {
      logger.info('WebSocket 客户端已断开', {
        remote,
        code,
        reason: reason.toString() || undefined,
        clients: this.wsServer?.clients.size ?? 0,
      });
    });

    socket.on('error', (error) => {
      logger.warn('WebSocket 连接异常', { remote, error });
    });
  }
}
