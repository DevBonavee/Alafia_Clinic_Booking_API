import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { HttpError } from './http.js';

export interface StoredResponse {
  status: number;
  body: unknown;
}

/** JSON with object keys sorted at every level, so {"a":1,"b":2} and {"b":2,"a":1} hash the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function requestHash(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

/** Reads the Idempotency-Key header. Blank means "no key"; over 255 characters is a 400. */
export function readIdempotencyKey(header: string | undefined): string | null {
  if (header === undefined || header.trim() === '') return null;
  if (header.length > 255) throw new HttpError(400, 'Idempotency-Key must be at most 255 characters');
  return header;
}

export type ClaimResult =
  | { kind: 'new' }
  | { kind: 'replay'; response: StoredResponse }
  | { kind: 'mismatch' };

/**
 * Claims the key inside the caller's transaction.
 * - New key: a row is inserted (and stays locked until commit), so concurrent requests with the
 *   same key wait on the INSERT and then see the finished result.
 * - Existing key: SELECT ... FOR UPDATE waits for any in-flight first request, then either
 *   replays its stored response or reports a body mismatch.
 */
export async function claimKey(client: PoolClient, key: string, hash: string): Promise<ClaimResult> {
  const inserted = await client.query(
    `INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2)
     ON CONFLICT (key) DO NOTHING RETURNING key`,
    [key, hash],
  );
  if (inserted.rows.length === 1) return { kind: 'new' };

  const { rows } = await client.query<{ request_hash: string; status_code: number | null; response_body: unknown }>(
    'SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = $1 FOR UPDATE',
    [key],
  );
  if (rows.length === 0) {
    // The row was removed between our INSERT and SELECT; claim it afresh.
    return claimKey(client, key, hash);
  }
  const row = rows[0];
  if (row.request_hash !== hash) return { kind: 'mismatch' };
  if (row.status_code === null) return { kind: 'new' }; // no stored result (a later level may clear it)
  return { kind: 'replay', response: { status: row.status_code, body: row.response_body } };
}

export async function storeResponse(client: PoolClient, key: string, response: StoredResponse): Promise<void> {
  await client.query('UPDATE idempotency_keys SET status_code = $2, response_body = $3 WHERE key = $1', [
    key,
    response.status,
    JSON.stringify(response.body),
  ]);
}
