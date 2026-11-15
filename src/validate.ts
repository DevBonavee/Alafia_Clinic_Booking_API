import { HttpError } from './http.js';

export interface NewBooking {
  slot_id: string;
  name: string;
  email: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requiredString(body: Record<string, unknown>, field: keyof NewBooking): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} is required`);
  }
  return value.trim();
}

/** Checks a POST /bookings body. Returns trimmed fields with the email in lower case, or throws a 400. */
export function parseNewBooking(body: unknown): NewBooking {
  if (!isPlainObject(body)) throw new HttpError(400, 'invalid JSON body');
  const slot_id = requiredString(body, 'slot_id');
  const name = requiredString(body, 'name');
  const email = requiredString(body, 'email').toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'email is invalid');
  return { slot_id, name, email };
}
