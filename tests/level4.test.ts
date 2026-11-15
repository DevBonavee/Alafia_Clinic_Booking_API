import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { closePool, getPool } from '../src/db.js';
import { stableStringify } from '../src/idempotency.js';
import { decodeCursor, encodeCursor } from '../src/pagination.js';
import { api, inMinutes, reset } from './helpers.js';

afterAll(closePool);

const BODY = { slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' };

async function bookingCount(where = 'true', params: unknown[] = []): Promise<number> {
  const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM bookings WHERE ${where}`, params);
  return rows[0].n;
}

describe('stableStringify', () => {
  it('ignores key order at every level', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      stableStringify({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});

describe('Idempotency-Key on POST /bookings', () => {
  beforeEach(() => reset());

  it('same key and body twice: same status and booking, one row', async () => {
    const a = await api.post('/bookings').set('Idempotency-Key', 'k-1').send(BODY);
    const b = await api.post('/bookings').set('Idempotency-Key', 'k-1').send(BODY);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(Object.keys(b.body)).toEqual(['id', 'slot_id', 'name', 'email', 'status', 'created_at']);
    expect(await bookingCount()).toBe(1);
  });

  it('key order in the body does not matter', async () => {
    const a = await api.post('/bookings').set('Idempotency-Key', 'k-order').send(BODY);
    const b = await api
      .post('/bookings')
      .set('Idempotency-Key', 'k-order')
      .send({ email: BODY.email, name: BODY.name, slot_id: BODY.slot_id });
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
  });

  it('replays the original even after the booking was cancelled', async () => {
    const a = await api.post('/bookings').set('Idempotency-Key', 'k-cancel').send(BODY);
    await api.delete(`/bookings/${a.body.id}`);
    const b = await api.post('/bookings').set('Idempotency-Key', 'k-cancel').send(BODY);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(await bookingCount()).toBe(1);
  });

  it('10 concurrent requests with one key create one booking and all get the same id', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => api.post('/bookings').set('Idempotency-Key', 'k-burst').send(BODY)),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await bookingCount()).toBe(1);
  });

  it('same key with a different body is 422 and creates nothing', async () => {
    const a = await api.post('/bookings').set('Idempotency-Key', 'k-2').send(BODY);
    const b = await api.post('/bookings').set('Idempotency-Key', 'k-2').send({ ...BODY, slot_id: 's2' });
    expect(b.status).toBe(422);
    expect(b.body).toEqual({ error: 'idempotency key reused with a different body' });
    expect(await bookingCount()).toBe(1);
    // The original stays replayable.
    const c = await api.post('/bookings').set('Idempotency-Key', 'k-2').send(BODY);
    expect(c.body.id).toBe(a.body.id);
  });

  it('a different body includes whitespace and case changes', async () => {
    await api.post('/bookings').set('Idempotency-Key', 'k-3').send(BODY);
    const b = await api.post('/bookings').set('Idempotency-Key', 'k-3').send({ ...BODY, email: 'ADA@example.com' });
    expect(b.status).toBe(422);
  });

  it('replays a 409', async () => {
    await api.post('/bookings').send({ ...BODY, email: 'first@example.com' });
    const a = await api.post('/bookings').set('Idempotency-Key', 'k-409').send(BODY);
    expect(a.status).toBe(409);
    // Free the slot: a fresh request would now succeed, but the key must replay the 409.
    const { rows } = await getPool().query("SELECT id FROM bookings WHERE slot_id = 's1'");
    await api.delete(`/bookings/${rows[0].id}`);
    const b = await api.post('/bookings').set('Idempotency-Key', 'k-409').send(BODY);
    expect(b.status).toBe(409);
    expect(b.body).toEqual({ error: 'slot already booked' });
  });

  it('replays a 400 and a 404', async () => {
    const bad = { ...BODY, email: 'nope' };
    const a = await api.post('/bookings').set('Idempotency-Key', 'k-400').send(bad);
    const b = await api.post('/bookings').set('Idempotency-Key', 'k-400').send(bad);
    expect([a.status, b.status]).toEqual([400, 400]);
    expect(b.body).toEqual({ error: 'email is invalid' });

    const ghost = { ...BODY, slot_id: 'ghost' };
    const c = await api.post('/bookings').set('Idempotency-Key', 'k-404').send(ghost);
    const d = await api.post('/bookings').set('Idempotency-Key', 'k-404').send(ghost);
    expect([c.status, d.status]).toEqual([404, 404]);
    expect(d.body).toEqual({ error: 'slot not found' });
  });

  it('different keys with the same body are separate requests', async () => {
    const a = await api.post('/bookings').set('Idempotency-Key', 'k-a').send(BODY);
    const b = await api.post('/bookings').set('Idempotency-Key', 'k-b').send(BODY);
    expect(a.status).toBe(201);
    expect(b.status).toBe(409);
  });

  it('without a key, every request is fresh', async () => {
    const a = await api.post('/bookings').send(BODY);
    const b = await api.post('/bookings').send(BODY);
    expect([a.status, b.status]).toEqual([201, 409]);
  });

  it('a blank key is treated as no key; a key over 255 characters is 400', async () => {
    const a = await api.post('/bookings').set('Idempotency-Key', '   ').send(BODY);
    expect(a.status).toBe(201);
    const b = await api.post('/bookings').set('Idempotency-Key', 'x'.repeat(256)).send({ ...BODY, slot_id: 's2' });
    expect(b.status).toBe(400);
    expect(await bookingCount("slot_id = 's2'")).toBe(0);
  });

  it('a 401 is never stored', async () => {
    const denied = await request(app).post('/bookings').set('Idempotency-Key', 'k-401').send(BODY);
    expect(denied.status).toBe(401);
    const ok = await api.post('/bookings').set('Idempotency-Key', 'k-401').send(BODY);
    expect(ok.status).toBe(201);
  });

  it('/reset clears stored keys', async () => {
    await api.post('/bookings').set('Idempotency-Key', 'k-reset').send(BODY);
    await reset();
    const again = await api.post('/bookings').set('Idempotency-Key', 'k-reset').send(BODY);
    expect(again.status).toBe(201);
    expect(await bookingCount()).toBe(1);
  });
});

describe('GET /bookings', () => {
  // 15 slots: Ada books p00–p11, Bo books p12–p13, p14 stays free.
  const slots = Array.from({ length: 15 }, (_, i) => ({
    id: `p${String(i).padStart(2, '0')}`,
    provider: 'Dr Ade',
    start: inMinutes(60 + i * 30),
    end: inMinutes(90 + i * 30),
  }));

  // The fixture books 12 times for one email in under a minute; lift the Level 5 limit for this suite.
  beforeAll(() => {
    process.env.RATE_LIMIT_MAX = '1000';
  });
  afterAll(() => {
    delete process.env.RATE_LIMIT_MAX;
  });

  beforeEach(async () => {
    await reset(slots);
    for (let i = 0; i < 12; i++) {
      const res = await api.post('/bookings').send({ slot_id: slots[i].id, name: 'Ada', email: 'ada@example.com' });
      expect(res.status).toBe(201);
    }
    for (const i of [12, 13]) {
      await api.post('/bookings').send({ slot_id: slots[i].id, name: 'Bo', email: 'bo@example.com' });
    }
  });

  async function allPages(query: Record<string, string>) {
    const pages: Array<{ bookings: Array<{ slot_id: string }>; next_cursor: string | null }> = [];
    let cursor: string | null = null;
    do {
      const res = await api.get('/bookings').query({ ...query, ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      pages.push(res.body);
      cursor = res.body.next_cursor;
    } while (cursor && pages.length < 20);
    return pages;
  }

  it('pages 12 bookings by 5 as 5, 5, 2, oldest first, ending with next_cursor null', async () => {
    const pages = await allPages({ email: 'ada@example.com', limit: '5' });
    expect(pages.map((p) => p.bookings.length)).toEqual([5, 5, 2]);
    expect(pages[0].next_cursor).toEqual(expect.any(String));
    expect(pages[1].next_cursor).toEqual(expect.any(String));
    expect(pages[2].next_cursor).toBeNull();
    const ids = pages.flatMap((p) => p.bookings.map((b) => b.slot_id));
    expect(ids).toEqual(slots.slice(0, 12).map((s) => s.id));
  });

  it('defaults to 10 per page', async () => {
    const res = await api.get('/bookings').query({ email: 'ada@example.com' });
    expect(res.body.bookings).toHaveLength(10);
    expect(res.body.next_cursor).toEqual(expect.any(String));
  });

  it('an exact final page has next_cursor null', async () => {
    const res = await api.get('/bookings').query({ email: 'ada@example.com', limit: '12' });
    expect(res.body.bookings).toHaveLength(12);
    expect(res.body.next_cursor).toBeNull();
  });

  it('returns Booking objects without internal fields', async () => {
    const res = await api.get('/bookings').query({ email: 'ada@example.com', limit: '1' });
    expect(Object.keys(res.body).sort()).toEqual(['bookings', 'next_cursor']);
    expect(Object.keys(res.body.bookings[0])).toEqual(['id', 'slot_id', 'name', 'email', 'status', 'created_at']);
  });

  it('matches the email ignoring case and spaces', async () => {
    const res = await api.get('/bookings').query({ email: '  ADA@Example.Com ', limit: '50' });
    expect(res.body.bookings).toHaveLength(12);
    expect(res.body.bookings.every((b: { email: string }) => b.email === 'ada@example.com')).toBe(true);
  });

  it('only returns that person\'s bookings', async () => {
    const res = await api.get('/bookings').query({ email: 'bo@example.com' });
    expect(res.body.bookings.map((b: { slot_id: string }) => b.slot_id)).toEqual(['p12', 'p13']);
    expect(res.body.next_cursor).toBeNull();
  });

  it('includes cancelled bookings', async () => {
    const first = await api.get('/bookings').query({ email: 'bo@example.com' });
    await api.delete(`/bookings/${first.body.bookings[0].id}`);
    const res = await api.get('/bookings').query({ email: 'bo@example.com' });
    expect(res.body.bookings.map((b: { status: string }) => b.status)).toEqual(['cancelled', 'confirmed']);
  });

  it('an unknown email gives an empty list', async () => {
    const res = await api.get('/bookings').query({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bookings: [], next_cursor: null });
  });

  it('a booking made between pages appears on the next page, with nothing repeated', async () => {
    const a = await api.get('/bookings').query({ email: 'bo@example.com', limit: '1' });
    expect(a.body.bookings.map((x: { slot_id: string }) => x.slot_id)).toEqual(['p12']);
    await api.post('/bookings').send({ slot_id: 'p14', name: 'Bo', email: 'bo@example.com' });
    const b = await api.get('/bookings').query({ email: 'bo@example.com', limit: '5', cursor: a.body.next_cursor });
    expect(b.body.bookings.map((x: { slot_id: string }) => x.slot_id)).toEqual(['p13', 'p14']);
    expect(b.body.next_cursor).toBeNull();
  });

  it.each([['0'], ['51'], ['-1'], ['1.5'], ['abc'], [''], ['1e1'], [' 5'], ['5x']])(
    'limit=%j is 400',
    async (limit) => {
      const res = await api.get('/bookings').query({ email: 'ada@example.com', limit });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'limit must be an integer from 1 to 50' });
    },
  );

  it('limit given twice is 400', async () => {
    const res = await api.get('/bookings?email=ada@example.com&limit=5&limit=6');
    expect(res.status).toBe(400);
  });

  it('limit=1 and limit=50 are allowed', async () => {
    expect((await api.get('/bookings').query({ email: 'ada@example.com', limit: '1' })).body.bookings).toHaveLength(1);
    expect((await api.get('/bookings').query({ email: 'ada@example.com', limit: '50' })).body.bookings).toHaveLength(12);
  });

  it.each([
    ['garbage', 'not a cursor!'],
    ['base64 of non-JSON', Buffer.from('hello').toString('base64url')],
    ['JSON without s', Buffer.from('{"x":1}').toString('base64url')],
    ['s as a string', Buffer.from('{"s":"5"}').toString('base64url')],
    ['negative s', Buffer.from('{"s":-1}').toString('base64url')],
    ['fractional s', Buffer.from('{"s":1.5}').toString('base64url')],
    ['JSON null', Buffer.from('null').toString('base64url')],
  ])('a cursor that is %s is 400', async (_label, cursor) => {
    const res = await api.get('/bookings').query({ email: 'ada@example.com', cursor });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid cursor' });
  });

  it('missing or blank email is 400', async () => {
    for (const q of [{}, { email: '' }, { email: '   ' }]) {
      const res = await api.get('/bookings').query(q);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'email is required' });
    }
  });

  it('needs the API key', async () => {
    expect((await request(app).get('/bookings').query({ email: 'ada@example.com' })).status).toBe(401);
  });

  it('cursor encode/decode round-trips', () => {
    expect(decodeCursor(encodeCursor(12345))).toBe(12345);
  });
});
