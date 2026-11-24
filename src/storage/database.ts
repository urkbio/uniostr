import { mkdirSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { initializeSchema } from './schema.js';

/**
 * SQLite 连接的统一封装：负责打开数据库、初始化结构以及关闭连接。
 * 业务查询应在后续阶段基于 connection 实现，避免把逻辑塞进本文件。
 */
export class RelayDatabase {
  readonly filePath: string;

  private readonly db: BetterSqlite3.Database;
  private closed = false;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    mkdirSync(path.dirname(this.filePath), { recursive: true });

    this.db = new BetterSqlite3(this.filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    initializeSchema(this.db);
  }

  get connection(): BetterSqlite3.Database {
    return this.db;
  }

  get isOpen(): boolean {
    return !this.closed && this.db.open;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.db.open) {
      this.db.close();
    }
  }
}
