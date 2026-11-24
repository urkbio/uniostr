import type BetterSqlite3 from 'better-sqlite3';

type Database = BetterSqlite3.Database;

interface Migration {
  version: number;
  up: (db: Database) => void;
}

/**
 * 简单的顺序迁移列表：通过 SQLite 的 PRAGMA user_version 记录当前结构版本。
 * 新增结构变更时，在末尾追加一条 version 递增的迁移即可。
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id         TEXT    PRIMARY KEY NOT NULL,
          pubkey     TEXT    NOT NULL,
          created_at INTEGER NOT NULL,
          kind       INTEGER NOT NULL,
          content    TEXT    NOT NULL,
          tags       TEXT    NOT NULL,
          sig        TEXT    NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_events_pubkey_created_at
          ON events (pubkey, created_at);
        CREATE INDEX IF NOT EXISTS idx_events_kind_created_at
          ON events (kind, created_at);
        CREATE INDEX IF NOT EXISTS idx_events_created_at
          ON events (created_at);
      `);
    },
  },
];

export const SCHEMA_VERSION = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);

/**
 * 应用尚未执行的迁移，使数据库结构达到最新版本。
 */
export function initializeSchema(db: Database): void {
  const currentVersion = Number(db.pragma('user_version', { simple: true }));

  const pending = MIGRATIONS.filter((migration) => migration.version > currentVersion).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
