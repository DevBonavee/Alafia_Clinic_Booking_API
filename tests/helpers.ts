import request from 'supertest';
import { app } from '../src/app.js';

export const API_KEY = process.env.API_KEY as string;

/** A request agent that always sends the API key (ignored until Level 2 enforces it). */
export const api = {
  get: (url: string) => request(app).get(url).set('X-API-Key', API_KEY),
  post: (url: string) => request(app).post(url).set('X-API-Key', API_KEY),
  delete: (url: string) => request(app).delete(url).set('X-API-Key', API_KEY),
};

/** ISO string without milliseconds, offset from now by the given minutes. */
export function inMinutes(minutes: number): string {
  return new Date(Math.floor(Date.now() / 60_000) * 60_000 + minutes * 60_000).toISOString().replace('.000Z', 'Z');
}

/** A fixed set of future slots, deliberately given out of order. */
export function sampleSlots() {
  return [
    { id: 's3', provider: 'Dr Chen', start: inMinutes(24 * 60 + 60), end: inMinutes(24 * 60 + 90) },
    { id: 's1', provider: 'Dr Ade', start: inMinutes(24 * 60), end: inMinutes(24 * 60 + 30) },
    { id: 's2', provider: 'Dr Bello', start: inMinutes(24 * 60), end: inMinutes(24 * 60 + 30) },
    { id: 's4', provider: 'Dr Ade', start: inMinutes(24 * 60 + 30), end: inMinutes(24 * 60 + 60) },
  ];
}

export async function reset(slots = sampleSlots()) {
  const res = await api.post('/reset').send({ slots });
  if (res.status !== 200) throw new Error(`reset failed: ${res.status} ${JSON.stringify(res.body)}`);
  return slots;
}
