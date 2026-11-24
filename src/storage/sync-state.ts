import type BetterSqlite3 from 'better-sqlite3';

export interface RemoteSyncState {
  /** 是否已完成历史回溯 */
  backfillComplete: boolean;
  /** 历史回溯下一页的 until 游标；null 表示从最新事件开始 */
  backfillCursor: number | null;
  /** 已收到事件的最大 created_at */
  lastSeen: number;
}

interface SyncStateRow {
  backfill_complete: number;
  backfill_cursor: number | null;
  last_seen: number;
}

/**
 * 远端同步进度持久化，避免每次启动都重新拉取全部历史。
 */
export class SyncStateStore {
  private readonly stmtGet: BetterSqlite3.Statement;
  private readonly stmtUpsert: BetterSqlite3.Statement;

  constructor(db: BetterSqlite3.Database) {
    this.stmtGet = db.prepare(
      'SELECT backfill_complete, backfill_cursor, last_seen FROM sync_state WHERE relay = ?',
    );
    this.stmtUpsert = db.prepare(
      `INSERT INTO sync_state (relay, backfill_complete, backfill_cursor, last_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (relay) DO UPDATE SET
         backfill_complete = excluded.backfill_complete,
         backfill_cursor = excluded.backfill_cursor,
         last_seen = excluded.last_seen`,
    );
  }

  get(relay: string): RemoteSyncState | undefined {
    const row = this.stmtGet.get(relay) as SyncStateRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      backfillComplete: row.backfill_complete === 1,
      backfillCursor: row.backfill_cursor,
      lastSeen: row.last_seen,
    };
  }

  save(relay: string, state: RemoteSyncState): void {
    this.stmtUpsert.run(
      relay,
      state.backfillComplete ? 1 : 0,
      state.backfillCursor,
      state.lastSeen,
    );
  }
}
