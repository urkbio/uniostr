import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isLogLevel, logger, type LogLevel } from '../utils/logger.js';

export interface RelayConfig {
  /** HTTP / WebSocket 监听地址 */
  host: string;
  /** 监听端口 */
  port: number;
  /** SQLite 数据库文件路径（相对路径基于工作目录） */
  database: string;
  /** 日志级别 */
  logLevel: LogLevel;
}

export const DEFAULT_CONFIG: RelayConfig = {
  host: '127.0.0.1',
  port: 7777,
  database: './data/relay.db',
  logLevel: 'info',
};

export const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), 'config.json');

export class ConfigError extends Error {
  readonly configPath: string;

  constructor(message: string, configPath: string) {
    super(message);
    this.name = 'ConfigError';
    this.configPath = configPath;
  }
}

function assertString(value: unknown, key: string, configPath: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`配置项 "${key}" 必须是非空字符串，当前值：${JSON.stringify(value)}`, configPath);
  }
  return value;
}

function validateConfig(raw: unknown, configPath: string): RelayConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('配置文件内容必须是 JSON 对象', configPath);
  }

  const source = raw as Record<string, unknown>;
  const host = assertString(source.host, 'host', configPath);
  const database = assertString(source.database, 'database', configPath);

  const port = source.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`配置项 "port" 必须是 1-65535 之间的整数，当前值：${JSON.stringify(port)}`, configPath);
  }

  const logLevel = source.logLevel;
  if (!isLogLevel(logLevel)) {
    throw new ConfigError(
      `配置项 "logLevel" 必须是 debug、info、warn、error 之一，当前值：${JSON.stringify(logLevel)}`,
      configPath,
    );
  }

  return { host, port, database, logLevel };
}

function writeDefaultConfig(configPath: string): void {
  try {
    writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new ConfigError(`无法生成默认配置文件：${(error as Error).message}`, configPath);
    }
  }
}

/**
 * 读取配置文件；文件不存在时自动生成默认配置。
 * 配置非法时抛出 ConfigError。
 */
export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): RelayConfig {
  if (!existsSync(configPath)) {
    writeDefaultConfig(configPath);
    logger.info('未找到配置文件，已生成默认配置', { path: configPath });
  }

  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new ConfigError(`无法读取配置文件：${(error as Error).message}`, configPath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`配置文件不是合法的 JSON：${(error as Error).message}`, configPath);
  }

  return validateConfig(parsed, configPath);
}
