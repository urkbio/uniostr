import { loadConfig } from '../config/config.js';
import { RelayDatabase } from '../storage/database.js';
import { EventStore } from '../storage/events.js';
import { setLogLevel } from '../utils/logger.js';

const HEX_ID_PATTERN = /^[0-9a-f]{64}$/;

function run(): void {
  const rawId = process.argv[2];
  const id = rawId?.trim().toLowerCase();

  if (!id || !HEX_ID_PATTERN.test(id)) {
    console.error('用法: npm run delete -- <64 位 hex 事件 id>');
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  setLogLevel(config.logLevel);

  const database = new RelayDatabase(config.database);
  try {
    const store = new EventStore(database.connection);
    const existed = store.deleteEventById(id);
    console.log(existed ? `已删除事件：${id}` : `事件不存在，已写入 tombstone：${id}`);
  } finally {
    database.close();
  }
}

try {
  run();
} catch (error) {
  console.error('删除失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
