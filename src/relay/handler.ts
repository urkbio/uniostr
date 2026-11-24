import type { RawData, WebSocket } from 'ws';
import { parseClientMessage, type ClientMessage } from '../protocol/message.js';
import { logger } from '../utils/logger.js';

const ID_PREVIEW_LENGTH = 16;

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

function sendNotice(socket: WebSocket, notice: string): void {
  if (socket.readyState !== socket.OPEN) {
    return;
  }
  try {
    socket.send(JSON.stringify(['NOTICE', notice]));
  } catch (error) {
    logger.warn('发送 NOTICE 失败', { error });
  }
}

/**
 * 记录已识别的消息。当前阶段不执行存储、订阅等业务逻辑，
 * 后续阶段在此按消息类型分发到对应处理器。
 */
function logMessage(message: ClientMessage): void {
  switch (message.type) {
    case 'EVENT':
      logger.info('收到 EVENT 消息', { eventId: preview(message.event.id), kind: message.event.kind });
      break;
    case 'AUTH':
      logger.info('收到 AUTH 消息', { eventId: preview(message.event.id) });
      break;
    case 'REQ':
      logger.info('收到 REQ 消息', { subscriptionId: preview(message.subscriptionId), filters: message.filters.length });
      break;
    case 'COUNT':
      logger.info('收到 COUNT 消息', { subscriptionId: preview(message.subscriptionId), filters: message.filters.length });
      break;
    case 'CLOSE':
      logger.info('收到 CLOSE 消息', { subscriptionId: preview(message.subscriptionId) });
      break;
  }
}

/**
 * WebSocket 消息入口：交给协议层解析，并输出基础日志。
 * 不记录完整 Event 内容或原始消息文本，避免泄露隐私数据。
 */
export function handleClientMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
  if (isBinary) {
    logger.warn('收到不支持的二进制消息');
    sendNotice(socket, 'unsupported: only text frames are accepted');
    return;
  }

  const result = parseClientMessage(toText(data));
  if (!result.ok) {
    logger.warn('无法解析客户端消息', { code: result.code, reason: result.error });
    sendNotice(socket, result.error);
    return;
  }

  logMessage(result.message);
}
