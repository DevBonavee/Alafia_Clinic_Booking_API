import type { PoolClient } from 'pg';

/** Defaults: 5 attempts per email per 60 seconds. Env overrides exist so tests can use a short window. */
function settings() {
  const max = Number.parseInt(process.env.RATE_LIMIT_MAX ?? '', 10);
  const windowSeconds = Number.parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS ?? '', 10);
  return {
    max: Number.isInteger(max) && max > 0 ? max : 5,
    windowSeconds: Number.isInteger(windowSeconds) && windowSeconds > 0 ? windowSeconds : 60,
  };
}

/** The email the limiter keys on: trimmed and lower case, or null if the body has no usable email. */
export function rateLimitEmail(body: unknown): string | null {
  const email = (body as { email?: unknown } | null)?.email;
  if (typeof email !== 'string' || email.trim() === '') return null;
  return email.trim().toLowerCase();
}

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Counts this attempt for the email, inside the caller's transaction.
 * A transaction-scoped advisory lock serialises attempts for one email, so concurrent
 * requests cannot all read "4 so far" and slip through together. Other emails are not blocked.
 * A rejected attempt is not recorded. An allowed one is recorded and counts even if the
 * booking then fails validation, as long as the caller commits.
 */
export async function checkRateLimit(client: PoolClient, email: string): Promise<RateLimitResult> {
  const { max, windowSeconds } = settings();
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [email]);
  await client.query(
    'DELETE FROM booking_attempts WHERE email = $1 AND at <= clock_timestamp() - make_interval(secs => $2)',
    [email, windowSeconds],
  );
  const { rows } = await client.query<{ n: number; retry_after: number | null }>(
    `SELECT count(*)::int AS n,
            GREATEST(1, CEIL(EXTRACT(EPOCH FROM (min(at) + make_interval(secs => $2) - clock_timestamp()))))::int
              AS retry_after
       FROM booking_attempts WHERE email = $1`,
    [email, windowSeconds],
  );
  if (rows[0].n >= max) {
    return { allowed: false, retryAfterSeconds: rows[0].retry_after ?? 1 };
  }
  await client.query('INSERT INTO booking_attempts (email, at) VALUES ($1, clock_timestamp())', [email]);
  return { allowed: true };
}
