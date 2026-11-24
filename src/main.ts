import { createApp } from './app/app.js';
import { logger } from './utils/logger.js';

const app = createApp();

app.start().catch((error: unknown) => {
  logger.error('应用启动失败', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
