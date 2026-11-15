import { HttpError } from './http.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** limit: absent means 10; otherwise digits only, 1 to 50. Anything else is a 400. */
export function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new HttpError(400, 'limit must be an integer from 1 to 50');
  }
  const n = Number(raw);
  if (n < 1 || n > MAX_LIMIT) throw new HttpError(400, 'limit must be an integer from 1 to 50');
  return n;
}

/** The cursor is base64url(JSON {s: seq}) of the last booking on the previous page. */
export function encodeCursor(seq: number): string {
  return Buffer.from(JSON.stringify({ s: seq })).toString('base64url');
}

/** Absent or empty cursor means "from the start" (seq 0). Anything malformed is a 400. */
export function decodeCursor(raw: unknown): number {
  if (raw === undefined || raw === '') return 0;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new HttpError(400, 'invalid cursor');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const s = (parsed as { s?: unknown } | null)?.s;
    if (typeof parsed === 'object' && parsed !== null && Number.isSafeInteger(s) && (s as number) >= 0) {
      return s as number;
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid cursor');
}
