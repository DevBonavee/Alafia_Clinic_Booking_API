/** ISO 8601 UTC without milliseconds, e.g. 2026-12-10T09:00:00Z. */
export function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface SlotRow {
  id: string;
  provider: string;
  start_at: Date;
  end_at: Date;
}

export interface BookingRow {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: 'confirmed' | 'cancelled';
  created_at: Date;
}

export function slotJson(row: SlotRow) {
  return { id: row.id, provider: row.provider, start: iso(row.start_at), end: iso(row.end_at) };
}

export function slotWithAvailabilityJson(row: SlotRow & { available: boolean }) {
  return { ...slotJson(row), available: row.available };
}

export function bookingJson(row: BookingRow) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: iso(row.created_at),
  };
}
