import { Router } from 'express';
import { withTransaction } from '../db.js';
import { asyncHandler, HttpError } from '../http.js';

interface SlotInput {
  id: string;
  provider: string;
  start: Date;
  end: Date;
}

const INVALID = 'slots must be an array of {id, provider, start, end} objects';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function parseDate(v: unknown): Date | null {
  if (!isNonEmptyString(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseSlots(body: unknown): SlotInput[] {
  const slots = (body as { slots?: unknown } | null)?.slots;
  if (!Array.isArray(slots)) throw new HttpError(400, INVALID);
  const seen = new Set<string>();
  return slots.map((s: unknown) => {
    if (typeof s !== 'object' || s === null) throw new HttpError(400, INVALID);
    const { id, provider, start, end } = s as Record<string, unknown>;
    const startDate = parseDate(start);
    const endDate = parseDate(end);
    if (!isNonEmptyString(id) || !isNonEmptyString(provider) || !startDate || !endDate) {
      throw new HttpError(400, INVALID);
    }
    if (seen.has(id)) throw new HttpError(400, `duplicate slot id: ${id}`);
    seen.add(id);
    return { id, provider, start: startDate, end: endDate };
  });
}

export const resetRouter = Router();

/** Replaces every slot and deletes all bookings (plus idempotency and rate-limit state) in one transaction. */
resetRouter.post(
  '/reset',
  asyncHandler(async (req, res) => {
    const slots = parseSlots(req.body);
    await withTransaction(async (client) => {
      await client.query('DELETE FROM bookings');
      await client.query('DELETE FROM idempotency_keys');
      await client.query('DELETE FROM booking_attempts');
      await client.query('DELETE FROM slots');
      if (slots.length > 0) {
        await client.query(
          `INSERT INTO slots (id, provider, start_at, end_at)
           SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::timestamptz[])`,
          [slots.map((s) => s.id), slots.map((s) => s.provider), slots.map((s) => s.start), slots.map((s) => s.end)],
        );
      }
    });
    res.status(200).json({ slots: slots.length });
  }),
);
