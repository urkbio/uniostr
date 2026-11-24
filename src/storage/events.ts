import type BetterSqlite3 from 'better-sqlite3';
import {
  getDTag,
  getExpiration,
  isAddressableKind,
  isEphemeralKind,
  isReplaceableKind,
  type NostrEvent,
} from '../protocol/event.js';
import type { NostrFilter } from '../protocol/filter.js';

export type SaveResult = 'stored' | 'duplicate' | 'superseded' | 'ephemeral' | 'expired' | 'deleted';

interface EventRow {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  content: string;
  tags: string;
  sig: string;
}

interface ExistingRow {
  id: string;
  created_at: number;
}

const HEX64_PATTERN = /^[0-9a-f]{64}$/;

const SQL_INSERT_EVENT = `
  INSERT INTO events (id, pubkey, created_at, kind, content, tags, sig, d_tag, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SQL_SELECT_COLUMNS = 'SELECT id, pubkey, created_at, kind, content, tags, sig FROM events';

function rowToEvent(row: EventRow): NostrEvent {
  let tags: string[][] = [];
  try {
    const parsed: unknown = JSON.parse(row.tags);
    if (Array.isArray(parsed)) {
      tags = parsed as string[][];
    }
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    kind: row.kind,
    content: row.content,
    tags,
    sig: row.sig,
  };
}

function prefixUpperBound(prefix: string): string {
  return `${prefix}\uFFFF`;
}

function parseCoordinate(value: string): { kind: number; pubkey: string; dTag: string } | null {
  const firstSeparator = value.indexOf(':');
  const secondSeparator = value.indexOf(':', firstSeparator + 1);
  if (firstSeparator <= 0 || secondSeparator < 0) {
    return null;
  }
  const kind = Number(value.slice(0, firstSeparator));
  const pubkey = value.slice(firstSeparator + 1, secondSeparator);
  const dTag = value.slice(secondSeparator + 1);
  if (!Number.isInteger(kind) || kind < 0 || !HEX64_PATTERN.test(pubkey)) {
    return null;
  }
  return { kind, pubkey, dTag };
}

function isConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

/**
 * 事件存储：NIP-01 去重/替换、NIP-33 可寻址、NIP-40 过期、NIP-09 删除。
 * 所有写入在单层事务内完成，业务规则不依赖数据库唯一索引。
 */
export class EventStore {
  private readonly saveTransaction: (event: NostrEvent) => SaveResult;

  private readonly stmtInsert: BetterSqlite3.Statement;
  private readonly stmtInsertTag: BetterSqlite3.Statement;
  private readonly stmtExistsId: BetterSqlite3.Statement;
  private readonly stmtLatestReplaceable: BetterSqlite3.Statement;
  private readonly stmtLatestAddressable: BetterSqlite3.Statement;
  private readonly stmtDeleteReplaceableOthers: BetterSqlite3.Statement;
  private readonly stmtDeleteAddressableOthers: BetterSqlite3.Statement;
  private readonly stmtDeletedEvent: BetterSqlite3.Statement;
  private readonly stmtInsertDeletedEvent: BetterSqlite3.Statement;
  private readonly stmtDeletedCoordinate: BetterSqlite3.Statement;
  private readonly stmtUpsertDeletedCoordinate: BetterSqlite3.Statement;
  private readonly stmtDeleteByAuthor: BetterSqlite3.Statement;
  private readonly stmtDeleteCoordinateEvents: BetterSqlite3.Statement;

  constructor(private readonly db: BetterSqlite3.Database) {
    this.stmtInsert = db.prepare(SQL_INSERT_EVENT);
    this.stmtInsertTag = db.prepare(
      'INSERT OR IGNORE INTO event_tags (event_id, name, value) VALUES (?, ?, ?)',
    );
    this.stmtExistsId = db.prepare('SELECT 1 FROM events WHERE id = ?');
    this.stmtLatestReplaceable = db.prepare(
      'SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? ORDER BY created_at DESC, id ASC LIMIT 1',
    );
    this.stmtLatestAddressable = db.prepare(
      `SELECT id, created_at FROM events
       WHERE pubkey = ? AND kind = ? AND COALESCE(d_tag, '') = ?
       ORDER BY created_at DESC, id ASC LIMIT 1`,
    );
    this.stmtDeleteReplaceableOthers = db.prepare('DELETE FROM events WHERE pubkey = ? AND kind = ? AND id <> ?');
    this.stmtDeleteAddressableOthers = db.prepare(
      "DELETE FROM events WHERE pubkey = ? AND kind = ? AND COALESCE(d_tag, '') = ? AND id <> ?",
    );
    this.stmtDeletedEvent = db.prepare('SELECT 1 FROM deleted_events WHERE event_id = ?');
    this.stmtInsertDeletedEvent = db.prepare(
      'INSERT OR IGNORE INTO deleted_events (event_id, deleted_at) VALUES (?, ?)',
    );
    this.stmtDeletedCoordinate = db.prepare(
      'SELECT until_created_at FROM deleted_coordinates WHERE pubkey = ? AND kind = ? AND d_tag = ?',
    );
    this.stmtUpsertDeletedCoordinate = db.prepare(
      `INSERT INTO deleted_coordinates (pubkey, kind, d_tag, until_created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (pubkey, kind, d_tag)
       DO UPDATE SET until_created_at = MAX(until_created_at, excluded.until_created_at)`,
    );
    this.stmtDeleteByAuthor = db.prepare('DELETE FROM events WHERE id = ? AND pubkey = ?');
    this.stmtDeleteCoordinateEvents = db.prepare(
      `DELETE FROM events
       WHERE pubkey = ? AND kind = ? AND COALESCE(d_tag, '') = ? AND created_at <= ?`,
    );

    this.saveTransaction = db.transaction((event: NostrEvent) => this.applySave(event));
  }

  save(event: NostrEvent): SaveResult {
    return this.saveTransaction(event);
  }

  query(filters: readonly NostrFilter[]): NostrEvent[] {
    const now = Math.floor(Date.now() / 1000);
    const collected = new Map<string, NostrEvent>();

    for (const filter of filters) {
      for (const row of this.selectByFilter(filter, now)) {
        if (!collected.has(row.id)) {
          collected.set(row.id, rowToEvent(row));
        }
      }
    }

    return [...collected.values()].sort((a, b) => {
      if (a.created_at !== b.created_at) {
        return b.created_at - a.created_at;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  private applySave(event: NostrEvent): SaveResult {
    if (this.stmtExistsId.get(event.id) !== undefined) {
      return 'duplicate';
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = getExpiration(event);
    if (expiresAt !== undefined && expiresAt <= now) {
      return 'expired';
    }

    if (isEphemeralKind(event.kind)) {
      return 'ephemeral';
    }

    if (this.stmtDeletedEvent.get(event.id) !== undefined) {
      return 'deleted';
    }

    const addressable = isAddressableKind(event.kind);
    const replaceable = isReplaceableKind(event.kind);
    const dTag = addressable ? getDTag(event) : null;

    if (replaceable || addressable) {
      const coordinateD = dTag ?? '';
      const tombstone = this.stmtDeletedCoordinate.get(event.pubkey, event.kind, coordinateD) as
        | { until_created_at: number }
        | undefined;
      if (tombstone && tombstone.until_created_at >= event.created_at) {
        return 'deleted';
      }

      const latest = (addressable
        ? this.stmtLatestAddressable.get(event.pubkey, event.kind, coordinateD)
        : this.stmtLatestReplaceable.get(event.pubkey, event.kind)) as ExistingRow | undefined;

      if (
        latest &&
        (latest.created_at > event.created_at ||
          (latest.created_at === event.created_at && latest.id < event.id))
      ) {
        return 'superseded';
      }

      this.insertRow(event, dTag, expiresAt);
      if (addressable) {
        this.stmtDeleteAddressableOthers.run(event.pubkey, event.kind, coordinateD, event.id);
      } else {
        this.stmtDeleteReplaceableOthers.run(event.pubkey, event.kind, event.id);
      }
    } else {
      try {
        this.insertRow(event, dTag, expiresAt);
      } catch (error) {
        if (isConstraintError(error)) {
          return 'duplicate';
        }
        throw error;
      }
    }

    if (event.kind === 5) {
      this.applyDeletionRequest(event);
    }

    return 'stored';
  }

  private insertRow(event: NostrEvent, dTag: string | null, expiresAt: number | undefined): void {
    this.stmtInsert.run(
      event.id,
      event.pubkey,
      event.created_at,
      event.kind,
      event.content,
      JSON.stringify(event.tags),
      event.sig,
      dTag,
      expiresAt ?? null,
    );

    for (const tag of event.tags) {
      const name = tag[0];
      const value = tag[1];
      if (name !== undefined && value !== undefined) {
        this.stmtInsertTag.run(event.id, name, value);
      }
    }
  }

  private applyDeletionRequest(event: NostrEvent): void {
    const now = Math.floor(Date.now() / 1000);

    for (const tag of event.tags) {
      const name = tag[0];
      const value = tag[1];
      if (name === 'e' && value !== undefined && HEX64_PATTERN.test(value)) {
        this.stmtDeleteByAuthor.run(value, event.pubkey);
        this.stmtInsertDeletedEvent.run(value, now);
      }
      if (name === 'a' && value !== undefined) {
        const coordinate = parseCoordinate(value);
        if (!coordinate || coordinate.pubkey !== event.pubkey) {
          continue;
        }
        this.stmtDeleteCoordinateEvents.run(
          coordinate.pubkey,
          coordinate.kind,
          coordinate.dTag,
          event.created_at,
        );
        this.stmtUpsertDeletedCoordinate.run(
          coordinate.pubkey,
          coordinate.kind,
          coordinate.dTag,
          event.created_at,
        );
      }
    }
  }

  private selectByFilter(filter: NostrFilter, now: number): EventRow[] {
    const conditions: string[] = ['(expires_at IS NULL OR expires_at > ?)'];
    const params: unknown[] = [now];

    if (filter.ids) {
      if (filter.ids.length === 0) {
        return [];
      }
      const placeholders = filter.ids.map(() => '(id >= ? AND id < ?)').join(' OR ');
      conditions.push(`(${placeholders})`);
      for (const prefix of filter.ids) {
        params.push(prefix, prefixUpperBound(prefix));
      }
    }

    if (filter.authors) {
      if (filter.authors.length === 0) {
        return [];
      }
      const placeholders = filter.authors.map(() => '(pubkey >= ? AND pubkey < ?)').join(' OR ');
      conditions.push(`(${placeholders})`);
      for (const prefix of filter.authors) {
        params.push(prefix, prefixUpperBound(prefix));
      }
    }

    if (filter.kinds) {
      if (filter.kinds.length === 0) {
        return [];
      }
      conditions.push(`kind IN (${filter.kinds.map(() => '?').join(', ')})`);
      params.push(...filter.kinds);
    }

    if (filter.since !== undefined) {
      conditions.push('created_at >= ?');
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      conditions.push('created_at <= ?');
      params.push(filter.until);
    }

    if (filter.tags) {
      for (const [name, values] of Object.entries(filter.tags)) {
        if (values.length === 0) {
          return [];
        }
        const placeholders = values.map(() => '?').join(', ');
        conditions.push(
          `EXISTS (SELECT 1 FROM event_tags et
                    WHERE et.event_id = events.id
                      AND et.name = ?
                      AND et.value IN (${placeholders}))`,
        );
        params.push(name, ...values);
      }
    }

    const sql = `${SQL_SELECT_COLUMNS} WHERE ${conditions.join(' AND ')}
                 ORDER BY created_at DESC, id ASC LIMIT ?`;
    params.push(filter.limit);

    return this.db.prepare(sql).all(...params) as EventRow[];
  }
}
