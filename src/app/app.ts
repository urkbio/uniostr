import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config/config.js';
import { RelayServer } from '../relay/server.js';
import { RelayDatabase } from '../storage/database.js';
import { logger, setLogLevel } from '../utils/logger.js';

export interface AppOptions {
  /** 配置文件路径，默认使用工作目录下的 config.json */
  configPath?: string;
}

export interface App {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const LOGS_DIR = path.resolve(process.cwd(), 'logs');

/**
 * 应用生命周期：加载配置 -> 初始化数据库 -> 启动 Relay -> 注册退出处理。
 * 关闭时按相反顺序释放资源，且重复调用 stop 不会重复释放。
 */
export function createApp(options: AppOptions = {}): App {
  let database: RelayDatabase | null = null;
  let server: RelayServer | null = null;
  let stopping: Promise<void> | null = null;

  async function stop(): Promise<void> {
    if (stopping) {
      return stopping;
    }

    stopping = (async () => {
      const currentServer = server;
      const currentDatabase = database;
      server = null;
      database = null;

      if (currentServer) {
        try {
          await currentServer.stop();
        } catch (error) {
          logger.error('关闭 Relay 服务失败', { error });
        }
      }

      if (currentDatabase) {
        try {
          currentDatabase.close();
          logger.info('数据库连接已关闭', { path: currentDatabase.filePath });
        } catch (error) {
          logger.error('关闭数据库失败', { error });
        }
      }
    })();

    return stopping;
  }

  function registerShutdownHandlers(): void {
    const handleSignal = (signal: NodeJS.Signals): void => {
      logger.info(`收到 ${signal} 信号，开始关闭应用`);
      let exitCode = 0;
      stop()
        .catch((error: unknown) => {
          logger.error('关闭应用时发生错误', { error });
          exitCode = 1;
        })
        .finally(() => {
          logger.info('应用已退出');
          process.exit(exitCode);
        });
    };

    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);
  }

  async function start(): Promise<void> {
    if (server) {
      throw new Error('应用已启动，不能重复启动');
    }

    try {
      const config = loadConfig(options.configPath);
      setLogLevel(config.logLevel);

      mkdirSync(LOGS_DIR, { recursive: true });

      database = new RelayDatabase(config.database);
      logger.info('数据库已就绪', { path: database.filePath });

      server = new RelayServer(config);
      await server.start();

      registerShutdownHandlers();
      logger.info('uniostr 已启动', { ws: `ws://${config.host}:${config.port}` });
    } catch (error) {
      await stop();
      throw error;
    }
  }

  return { start, stop };
}
