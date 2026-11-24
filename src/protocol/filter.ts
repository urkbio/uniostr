import { isExpired, type NostrEvent } from './event.js';

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit: number;
  tags?: Record<string, string[]>;
}

export const DEFAULT_FILTER_LIMIT = 500;
export const MAX_FILTER_LIMIT = 5000;

const HEX_PREFIX_PATTERN = /^[0-9a-fA-F]{1,64}$/;
const TAG_KEY_PATTERN = /^#[A-Za-z0-9_]+$/;

export class FilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterError';
  }
}

function normalizeHexPrefixes(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new FilterError(`filter.${field} must be an array of hex strings`);
  }
  return value.map((item) => {
    if (typeof item !== 'string' || !HEX_PREFIX_PATTERN.test(item)) {
      throw new FilterError(`filter.${field} contains an invalid hex prefix`);
    }
    return item.toLowerCase();
  });
}

function normalizeInteger(value: unknown, field: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new FilterError(`filter.${field} must be an integer >= ${min}`);
  }
  return value;
}

/**
 * 校验并规范化客户端 filter：未知字段忽略，limit 缺省 500、上限 5000。
 */
export function normalizeFilter(raw: Record<string, unknown>): NostrFilter {
  const filter: NostrFilter = { limit: DEFAULT_FILTER_LIMIT };

  if (raw.ids !== undefined) {
    filter.ids = normalizeHexPrefixes(raw.ids, 'ids');
  }
  if (raw.authors !== undefined) {
    filter.authors = normalizeHexPrefixes(raw.authors, 'authors');
  }
  if (raw.kinds !== undefined) {
    if (!Array.isArray(raw.kinds)) {
      throw new FilterError('filter.kinds must be an array of integers');
    }
    filter.kinds = raw.kinds.map((kind) => normalizeInteger(kind, 'kinds', 0));
  }
  if (raw.since !== undefined) {
    filter.since = normalizeInteger(raw.since, 'since', 0);
  }
  if (raw.until !== undefined) {
    filter.until = normalizeInteger(raw.until, 'until', 0);
  }
  if (raw.limit !== undefined) {
    const limit = normalizeInteger(raw.limit, 'limit', 0);
    filter.limit = Math.min(limit, MAX_FILTER_LIMIT);
  }

  const tags: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  let hasTags = false;
  for (const [key, value] of Object.entries(raw)) {
    if (!TAG_KEY_PATTERN.test(key)) {
      continue;
    }
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      throw new FilterError(`filter.${key} must be an array of strings`);
    }
    tags[key.slice(1)] = value;
    hasTags = true;
  }
  if (hasTags) {
    filter.tags = tags;
  }

  return filter;
}

export function normalizeFilters(raw: Record<string, unknown>[]): NostrFilter[] {
  return raw.map(normalizeFilter);
}

function matchesPrefix(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

/**
 * 实时推送使用的内存匹配，语义与 SQL 查询保持一致。
 */
export function matchesFilter(event: NostrEvent, filter: NostrFilter, now: number): boolean {
  if (isExpired(event, now)) {
    return false;
  }

  if (filter.ids !== undefined && (filter.ids.length === 0 || !matchesPrefix(event.id, filter.ids))) {
    return false;
  }
  if (filter.authors !== undefined && (filter.authors.length === 0 || !matchesPrefix(event.pubkey, filter.authors))) {
    return false;
  }
  if (filter.kinds !== undefined && (filter.kinds.length === 0 || !filter.kinds.includes(event.kind))) {
    return false;
  }
  if (filter.since !== undefined && event.created_at < filter.since) {
    return false;
  }
  if (filter.until !== undefined && event.created_at > filter.until) {
    return false;
  }

  if (filter.tags) {
    for (const [name, values] of Object.entries(filter.tags)) {
      if (values.length === 0) {
        return false;
      }
      const matched = event.tags.some(
        (tag) => tag.length > 1 && tag[0] === name && tag[1] !== undefined && values.includes(tag[1]),
      );
      if (!matched) {
        return false;
      }
    }
  }

  return true;
}

export function matchesAnyFilter(event: NostrEvent, filters: readonly NostrFilter[], now: number): boolean {
  return filters.some((filter) => matchesFilter(event, filter, now));
}
