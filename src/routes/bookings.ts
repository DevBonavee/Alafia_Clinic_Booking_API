import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { getPool } from '../db.js';
import { bookingJson, type BookingRow } from '../format.js';
import { asyncHandler, HttpError } from '../http.js';

const BOOKING_COLUMNS = 'id, slot_id, name, email, status, created_at';

function newBookingId(): string {
  return 'bk_' + randomBytes(12).toString('hex');
}

export const bookingsRouter = Router();

/** Level 1: books a slot with a plain insert. Validation, conflicts, idempotency and rate limits come in later levels. */
bookingsRouter.post(
  '/bookings',
  asyncHandler(async (req, res) => {
    const { slot_id, name, email } = (req.body ?? {}) as Record<string, unknown>;
    const { rows } = await getPool().query<BookingRow>(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       RETURNING ${BOOKING_COLUMNS}`,
      [newBookingId(), slot_id, name, email],
    );
    res.status(201).json(bookingJson(rows[0]));
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
