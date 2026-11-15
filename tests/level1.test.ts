import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { closePool, getPool } from '../src/db.js';
import { api, inMinutes, reset, sampleSlots } from './helpers.js';

const ISO_NO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

afterAll(closePool);

describe('POST /reset', () => {
  it('replaces all slots and returns the count', async () => {
    const res = await api.post('/reset').send({ slots: sampleSlots() });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ slots: 4 });

    const again = await api.post('/reset').send({ slots: [sampleSlots()[0]] });
    expect(again.body).toEqual({ slots: 1 });
    const list = await api.get('/slots');
    expect(list.body.slots.map((s: { id: string }) => s.id)).toEqual(['s3']);
  });

  it('accepts slots in the past', async () => {
    const past = { id: 'old', provider: 'Dr Ade', start: inMinutes(-120), end: inMinutes(-90) };
    const res = await api.post('/reset').send({ slots: [past] });
    expect(res.status).toBe(200);
    const list = await api.get('/slots');
    expect(list.body.slots[0]).toMatchObject({ id: 'old', start: past.start, end: past.end });
  });

  it('accepts an empty list', async () => {
    const res = await api.post('/reset').send({ slots: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slots: 0 });
    expect((await api.get('/slots')).body).toEqual({ slots: [] });
  });

  it('deletes every booking', async () => {
    await reset();
    const booked = await api.post('/bookings').send({ slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' });
    await reset();
    expect((await api.get(`/bookings/${booked.body.id}`)).status).toBe(404);
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM bookings');
    expect(rows[0].n).toBe(0);
  });

  it.each([
    ['no body', undefined],
    ['slots missing', {}],
    ['slots not an array', { slots: 'nope' }],
    ['slot not an object', { slots: [42] }],
    ['slot missing a field', { slots: [{ id: 'x', provider: 'Dr Ade', start: '2026-12-10T09:00:00Z' }] }],
    ['slot with a bad date', { slots: [{ id: 'x', provider: 'Dr Ade', start: 'soon', end: '2026-12-10T09:30:00Z' }] }],
    [
      'duplicate ids',
      {
        slots: [
          { id: 'x', provider: 'Dr Ade', start: '2026-12-10T09:00:00Z', end: '2026-12-10T09:30:00Z' },
          { id: 'x', provider: 'Dr Bello', start: '2026-12-10T09:00:00Z', end: '2026-12-10T09:30:00Z' },
        ],
      },
    ],
  ])('returns 400 for %s and keeps existing slots', async (_label, body) => {
    await reset();
    const res = await api.post('/reset').send(body as object);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expect((await api.get('/slots')).body.slots).toHaveLength(4);
  });
});

describe('GET /slots', () => {
  beforeEach(() => reset());

  it('lists every slot earliest first, tie-broken by id, with availability', async () => {
    const res = await api.get('/slots');
    expect(res.status).toBe(200);
    expect(res.body.slots.map((s: { id: string }) => s.id)).toEqual(['s1', 's2', 's4', 's3']);
    for (const slot of res.body.slots) {
      expect(Object.keys(slot).sort()).toEqual(['available', 'end', 'id', 'provider', 'start']);
      expect(slot.start).toMatch(ISO_NO_MS);
      expect(slot.end).toMatch(ISO_NO_MS);
      expect(slot.available).toBe(true);
    }
  });

  it('returns start and end exactly as sent', async () => {
    const sent = sampleSlots().find((s) => s.id === 's1')!;
    const res = await api.get('/slots');
    expect(res.body.slots[0]).toEqual({ ...sent, available: true });
  });

  it('filters by provider (exact match)', async () => {
    const res = await api.get('/slots').query({ provider: 'Dr Ade' });
    expect(res.status).toBe(200);
    expect(res.body.slots.map((s: { id: string }) => s.id)).toEqual(['s1', 's4']);
    expect((await api.get('/slots').query({ provider: 'dr ade' })).body.slots).toEqual([]);
    expect((await api.get('/slots').query({ provider: 'Dr' })).body.slots).toEqual([]);
  });

  it('marks a booked slot unavailable', async () => {
    await api.post('/bookings').send({ slot_id: 's2', name: 'Ada Obi', email: 'ada@example.com' });
    const res = await api.get('/slots');
    const byId = Object.fromEntries(res.body.slots.map((s: { id: string; available: boolean }) => [s.id, s.available]));
    expect(byId).toEqual({ s1: true, s2: false, s3: true, s4: true });
  });
});

describe('POST /bookings', () => {
  beforeEach(() => reset());

  it('returns 201 with a confirmed booking', async () => {
    const before = Date.now();
    const res = await api.post('/bookings').send({ slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' });
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(Object.keys(res.body).sort()).toEqual(['created_at', 'email', 'id', 'name', 'slot_id', 'status']);
    expect(res.body).toMatchObject({ slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com', status: 'confirmed' });
    expect(typeof res.body.id).toBe('string');
    expect(res.body.id.length).toBeGreaterThan(3);
    expect(res.body.created_at).toMatch(ISO_NO_MS);
    expect(new Date(res.body.created_at).getTime()).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 - 5000);
  });

  it('gives every booking a unique id', async () => {
    const a = await api.post('/bookings').send({ slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' });
    const b = await api.post('/bookings').send({ slot_id: 's2', name: 'Bayo Lawal', email: 'bayo@example.com' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
  });

  it('persists the booking', async () => {
    const res = await api.post('/bookings').send({ slot_id: 's3', name: 'Ada Obi', email: 'ada@example.com' });
    const { rows } = await getPool().query('SELECT slot_id, status FROM bookings WHERE id = $1', [res.body.id]);
    expect(rows).toEqual([{ slot_id: 's3', status: 'confirmed' }]);
  });
});

describe('GET /bookings/:id', () => {
  beforeEach(() => reset());

  it('returns the booking', async () => {
    const created = await api.post('/bookings').send({ slot_id: 's4', name: 'Ada Obi', email: 'ada@example.com' });
    const res = await api.get(`/bookings/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await api.get('/bookings/bk_doesnotexist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'booking not found' });
  });
});

describe('errors and the web page', () => {
  it('returns JSON 404 for unknown routes', async () => {
    const res = await api.get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('returns 400 for a malformed JSON body', async () => {
    const res = await api.post('/reset').set('Content-Type', 'application/json').send('{"slots": [');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid JSON body' });
  });

  it.each(['/', '/index.html', '/app.js', '/styles.css', '/logo.svg'])('serves %s', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
  });
});
