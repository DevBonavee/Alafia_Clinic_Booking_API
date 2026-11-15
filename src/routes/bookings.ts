import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../db.js';
import { bookingJson, type BookingRow } from '../format.js';
import { asyncHandler, HttpError } from '../http.js';
import { claimKey, readIdempotencyKey, requestHash, storeResponse, type StoredResponse } from '../idempotency.js';
import { decodeCursor, encodeCursor, parseLimit } from '../pagination.js';
import { parseNewBooking } from '../validate.js';

const BOOKING_COLUMNS = 'id, slot_id, name, email, status, created_at';
const BOOKING_KEY_ORDER = ['id', 'slot_id', 'name', 'email', 'status', 'created_at'] as const;

function newBookingId(): string {
  return 'bk_' + randomBytes(12).toString('hex');
}

/** jsonb does not keep key order; put a replayed booking's fields back in the usual order. */
function inBookingOrder(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || !('slot_id' in body)) return body;
  const b = body as Record<string, unknown>;
  return Object.fromEntries(BOOKING_KEY_ORDER.map((k) => [k, b[k]]));
}

/**
 * The booking itself: validate fields (400), slot exists (404), slot not started (400),
 * insert (201) or slot taken (409). Business errors come back as a response, not a throw,
 * so the surrounding transaction can store them on the idempotency key and still commit.
 *
 * Double booking is prevented by the partial unique index one_confirmed_booking_per_slot.
 * ON CONFLICT DO NOTHING turns a clash into "no row returned" without aborting the transaction.
 */
async function createBooking(client: PoolClient, rawBody: unknown): Promise<StoredResponse> {
  try {
    const { slot_id, name, email } = parseNewBooking(rawBody);

    // FOR SHARE keeps a concurrent /reset from deleting the slot before this transaction commits.
    const slot = await client.query<{ started: boolean }>(
      'SELECT start_at <= now() AS started FROM slots WHERE id = $1 FOR SHARE',
      [slot_id],
    );
    if (slot.rows.length === 0) throw new HttpError(404, 'slot not found');
    if (slot.rows[0].started) throw new HttpError(400, 'slot has already started');

    const { rows } = await client.query<BookingRow>(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
       RETURNING ${BOOKING_COLUMNS}`,
      [newBookingId(), slot_id, name, email],
    );
    if (rows.length === 0) throw new HttpError(409, 'slot already booked');
    return { status: 201, body: bookingJson(rows[0]) };
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
}

export const bookingsRouter = Router();

/**
 * POST /bookings. Order: (auth and JSON parsing happen in middleware) BEGIN, idempotency
 * replay or 422, booking, store the response on the key, COMMIT.
 */
bookingsRouter.post(
  '/bookings',
  asyncHandler(async (req, res) => {
    const key = readIdempotencyKey(req.get('Idempotency-Key'));

    const response = await withTransaction(async (client): Promise<StoredResponse> => {
      if (key !== null) {
        const claim = await claimKey(client, key, requestHash(req.body));
        if (claim.kind === 'mismatch') {
          return { status: 422, body: { error: 'idempotency key reused with a different body' } };
        }
        if (claim.kind === 'replay') {
          return { status: claim.response.status, body: inBookingOrder(claim.response.body) };
        }
      }

      const result = await createBooking(client, req.body);
      if (key !== null) await storeResponse(client, key, result);
      return result;
    });

    res.status(response.status).json(response.body);
  }),
);

/** GET /bookings?email=&limit=&cursor= : one person's bookings, oldest first, cursor-paginated. */
bookingsRouter.get(
  '/bookings',
  asyncHandler(async (req, res) => {
    const rawEmail = req.query.email;
    if (typeof rawEmail !== 'string' || rawEmail.trim() === '') throw new HttpError(400, 'email is required');
    const email = rawEmail.trim().toLowerCase();
    const limit = parseLimit(req.query.limit);
    const afterSeq = decodeCursor(req.query.cursor);

    const { rows } = await getPool().query<BookingRow & { seq: string }>(
      `SELECT seq, ${BOOKING_COLUMNS} FROM bookings
        WHERE email = $1 AND seq > $2
        ORDER BY seq ASC
        LIMIT $3`,
      [email, afterSeq, limit + 1],
    );
    const page = rows.slice(0, limit);
    const next_cursor = rows.length > limit ? encodeCursor(Number(page[page.length - 1].seq)) : null;
    res.status(200).json({ bookings: page.map(bookingJson), next_cursor });
  }),
);

bookingsRouter.get(
  '/bookings/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await getPool().query<BookingRow>(
      `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`,
      [req.params.id],
    );
    if (rows.length === 0) throw new HttpError(404, 'booking not found');
    res.status(200).json(bookingJson(rows[0]));
  }),
);

/** Cancels a booking and frees its slot. 404 if unknown, 409 if already cancelled. */
bookingsRouter.delete(
  '/bookings/:id',
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const updated = await pool.query<BookingRow>(
      `UPDATE bookings SET status = 'cancelled'
        WHERE id = $1 AND status = 'confirmed'
        RETURNING ${BOOKING_COLUMNS}`,
      [req.params.id],
    );
    if (updated.rows.length === 1) {
      res.status(200).json(bookingJson(updated.rows[0]));
      return;
    }
    const existing = await pool.query('SELECT 1 FROM bookings WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) throw new HttpError(404, 'booking not found');
    throw new HttpError(409, 'booking already cancelled');
  }),
);
