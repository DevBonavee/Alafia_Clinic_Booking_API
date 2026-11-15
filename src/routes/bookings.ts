import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { getPool } from '../db.js';
import { bookingJson, type BookingRow } from '../format.js';
import { asyncHandler, HttpError } from '../http.js';
import { parseNewBooking } from '../validate.js';

const BOOKING_COLUMNS = 'id, slot_id, name, email, status, created_at';

function newBookingId(): string {
  return 'bk_' + randomBytes(12).toString('hex');
}

export const bookingsRouter = Router();

/**
 * Books a slot: validate fields (400), slot exists (404), slot not started (400), insert (201 or 409).
 *
 * Double booking is prevented by the partial unique index one_confirmed_booking_per_slot, not by
 * reading first. ON CONFLICT DO NOTHING turns a clash into "no row returned" (409) without
 * raising an error, so it stays safe inside a transaction later (Level 4).
 */
bookingsRouter.post(
  '/bookings',
  asyncHandler(async (req, res) => {
    const { slot_id, name, email } = parseNewBooking(req.body);

    const slot = await getPool().query<{ started: boolean }>(
      'SELECT start_at <= now() AS started FROM slots WHERE id = $1',
      [slot_id],
    );
    if (slot.rows.length === 0) throw new HttpError(404, 'slot not found');
    if (slot.rows[0].started) throw new HttpError(400, 'slot has already started');

    try {
      const { rows } = await getPool().query<BookingRow>(
        `INSERT INTO bookings (id, slot_id, name, email, status)
         VALUES ($1, $2, $3, $4, 'confirmed')
         ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
         RETURNING ${BOOKING_COLUMNS}`,
        [newBookingId(), slot_id, name, email],
      );
      if (rows.length === 0) throw new HttpError(409, 'slot already booked');
      res.status(201).json(bookingJson(rows[0]));
    } catch (err) {
      // The slot vanished between the check and the insert (a concurrent /reset).
      if ((err as { code?: string }).code === '23503') throw new HttpError(404, 'slot not found');
      throw err;
    }
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
