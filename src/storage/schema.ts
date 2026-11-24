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
  {
    version: 2,
    up(db) {
      db.exec(`
        ALTER TABLE events ADD COLUMN d_tag TEXT;
        ALTER TABLE events ADD COLUMN expires_at INTEGER;

        UPDATE events SET d_tag = (
          SELECT json_extract(t.value, '$[1]')
          FROM json_each(events.tags) t
          WHERE json_extract(t.value, '$[0]') = 'd'
          LIMIT 1
        );
        UPDATE events SET expires_at = CAST((
          SELECT json_extract(t.value, '$[1]')
          FROM json_each(events.tags) t
          WHERE json_extract(t.value, '$[0]') = 'expiration'
          LIMIT 1
        ) AS INTEGER);

        CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind_created_at
          ON events (pubkey, kind, created_at);

        CREATE TABLE IF NOT EXISTS deleted_events (
          event_id   TEXT    PRIMARY KEY NOT NULL,
          deleted_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS deleted_coordinates (
          pubkey           TEXT    NOT NULL,
          kind             INTEGER NOT NULL,
          d_tag            TEXT    NOT NULL,
          until_created_at INTEGER NOT NULL,
          PRIMARY KEY (pubkey, kind, d_tag)
        );
      `);
    },
  },
  {
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS event_tags (
          event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          name     TEXT NOT NULL,
          value    TEXT NOT NULL,
          PRIMARY KEY (event_id, name, value)
        );

        CREATE INDEX IF NOT EXISTS idx_event_tags_name_value
          ON event_tags (name, value, event_id);

        INSERT OR IGNORE INTO event_tags (event_id, name, value)
        SELECT e.id, json_extract(t.value, '$[0]'), json_extract(t.value, '$[1]')
        FROM events e, json_each(e.tags) t
        WHERE json_extract(t.value, '$[0]') IS NOT NULL
          AND json_extract(t.value, '$[1]') IS NOT NULL;
      `);
    },
  },
  {
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_state (
          relay             TEXT    PRIMARY KEY NOT NULL,
          backfill_complete INTEGER NOT NULL DEFAULT 0,
          backfill_cursor   INTEGER,
          last_seen         INTEGER NOT NULL DEFAULT 0
        );
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
