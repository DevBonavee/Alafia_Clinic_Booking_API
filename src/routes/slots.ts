import { Router } from 'express';
import { getPool } from '../db.js';
import { slotWithAvailabilityJson, type SlotRow } from '../format.js';
import { asyncHandler } from '../http.js';

export const slotsRouter = Router();

/** Lists every slot, earliest start first, with availability. Optional exact-match ?provider= filter. */
slotsRouter.get(
  '/slots',
  asyncHandler(async (req, res) => {
    const provider = typeof req.query.provider === 'string' ? req.query.provider : null;
    const { rows } = await getPool().query<SlotRow & { available: boolean }>(
      `SELECT s.id, s.provider, s.start_at, s.end_at,
              NOT EXISTS (
                SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed'
              ) AS available
         FROM slots s
        WHERE $1::text IS NULL OR s.provider = $1
        ORDER BY s.start_at ASC, s.id ASC`,
      [provider],
    );
    res.status(200).json({ slots: rows.map(slotWithAvailabilityJson) });
  }),
);
