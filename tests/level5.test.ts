import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { closePool, getPool } from '../src/db.js';
import { api, inMinutes, reset } from './helpers.js';

afterAll(closePool);

const TOO_MANY = { error: 'too many booking attempts, try again later' };

// Enough future slots that the limiter, not a 409, is what we hit.
const slots = Array.from({ length: 20 }, (_, i) => ({
  id: `r${i}`,
  provider: 'Dr Ade',
  start: inMinutes(60 + i * 30),
  end: inMinutes(90 + i * 30),
}));

const book = (slot: number, email: string, extra: Record<string, unknown> = {}) =>
  api.post('/bookings').send({ slot_id: `r${slot}`, name: 'Ada', email, ...extra });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function attempts(email: string): Promise<number> {
  const { rows } = await getPool().query('SELECT count(*)::int AS n FROM booking_attempts WHERE email = $1', [email]);
  return rows[0].n;
}

beforeEach(() => reset(slots));
afterEach(() => {
  delete process.env.RATE_LIMIT_WINDOW_SECONDS;
  delete process.env.RATE_LIMIT_MAX;
});

describe('rate limit: 5 booking attempts per email per minute', () => {
  it('the 6th attempt gets 429 with an integer Retry-After of at least 1', async () => {
    for (let i = 0; i < 5; i++) expect((await book(i, 'ada@example.com')).status).toBe(201);
    const sixth = await book(5, 'ada@example.com');
    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual(TOO_MANY);
    expect(sixth.headers['retry-after']).toMatch(/^\d+$/);
    const retryAfter = Number(sixth.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    const { rows } = await getPool().query("SELECT count(*)::int AS n FROM bookings WHERE slot_id = 'r5'");
    expect(rows[0].n).toBe(0);
  });

  it('failed attempts count too (400, 404, 409)', async () => {
    await book(0, 'ada@example.com'); // 201
    await book(0, 'ada@example.com'); // 409
    await api.post('/bookings').send({ slot_id: 'nope', name: 'Ada', email: 'ada@example.com' }); // 404
    await api.post('/bookings').send({ slot_id: 'r1', name: '', email: 'ada@example.com' }); // 400 name
    await api.post('/bookings').send({ slot_id: 'r1', name: 'Ada', email: 'ada@example' }); // 400 invalid email
    expect(await attempts('ada@example')).toBe(1); // a different (invalid) email is its own bucket
    await book(2, 'ada@example.com'); // 201, 5th for ada@example.com
    expect((await book(3, 'ada@example.com')).status).toBe(429);
  });

  it('counts the email after trimming and lower-casing', async () => {
    const variants = ['ada@example.com', 'ADA@example.com', ' Ada@Example.com ', 'ada@EXAMPLE.COM', 'ada@example.com'];
    for (let i = 0; i < 5; i++) expect((await book(i, variants[i])).status).toBe(201);
    expect((await book(5, 'Ada@example.com')).status).toBe(429);
  });

  it('a rejected attempt is not recorded, so it does not push the wait further', async () => {
    for (let i = 0; i < 5; i++) await book(i, 'ada@example.com');
    for (let i = 0; i < 3; i++) expect((await book(10 + i, 'ada@example.com')).status).toBe(429);
    expect(await attempts('ada@example.com')).toBe(5);
  });

  it('other emails are not affected', async () => {
    for (let i = 0; i < 5; i++) await book(i, 'ada@example.com');
    expect((await book(5, 'ada@example.com')).status).toBe(429);
    expect((await book(6, 'bo@example.com')).status).toBe(201);
  });

  it('requests with no usable email skip the limiter and get a 400', async () => {
    for (let i = 0; i < 8; i++) {
      const res = await api.post('/bookings').send({ slot_id: 'r0', name: 'Ada' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'email is required' });
    }
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM booking_attempts');
    expect(rows[0].n).toBe(0);
  });

  it('holds under concurrency: 12 parallel attempts give exactly 5 through and 7 × 429', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => book(i, 'burst@example.com')));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
    expect(await attempts('burst@example.com')).toBe(5);
  });

  it('only POST /bookings is limited', async () => {
    for (let i = 0; i < 5; i++) await book(i, 'ada@example.com');
    expect((await api.get('/bookings').query({ email: 'ada@example.com' })).status).toBe(200);
    expect((await api.get('/slots')).status).toBe(200);
    const { rows } = await getPool().query("SELECT id FROM bookings WHERE email = 'ada@example.com' LIMIT 1");
    expect((await api.delete(`/bookings/${rows[0].id}`)).status).toBe(200);
  });

  it('requests without the API key never count', async () => {
    for (let i = 0; i < 10; i++) {
      await request(app).post('/bookings').send({ slot_id: `r${i}`, name: 'Ada', email: 'ada@example.com' });
    }
    expect(await attempts('ada@example.com')).toBe(0);
    expect((await book(0, 'ada@example.com')).status).toBe(201);
  });

  it('opens again once the window has passed', async () => {
    process.env.RATE_LIMIT_WINDOW_SECONDS = '2';
    for (let i = 0; i < 5; i++) await book(i, 'ada@example.com');
    const blocked = await book(5, 'ada@example.com');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(2);
    await sleep(2100);
    expect((await book(5, 'ada@example.com')).status).toBe(201);
  });

  it('Retry-After counts down to when the oldest attempt leaves the window', async () => {
    process.env.RATE_LIMIT_WINDOW_SECONDS = '4';
    await book(0, 'ada@example.com');
    await sleep(1500);
    for (let i = 1; i < 5; i++) await book(i, 'ada@example.com');
    const blocked = await book(5, 'ada@example.com');
    expect(blocked.status).toBe(429);
    // Oldest attempt is ~1.5s old in a 4s window: about 3s left (rounded up).
    expect(Number(blocked.headers['retry-after'])).toBe(3);
  });

  it('/reset clears the attempts', async () => {
    for (let i = 0; i < 5; i++) await book(i, 'ada@example.com');
    await reset(slots);
    expect((await book(0, 'ada@example.com')).status).toBe(201);
  });
});

describe('rate limit with Idempotency-Key', () => {
  it('a replay does not count as an attempt', async () => {
    const first = await api.post('/bookings').set('Idempotency-Key', 'rk-1').send({ slot_id: 'r0', name: 'Ada', email: 'ada@example.com' });
    for (let i = 0; i < 10; i++) {
      const again = await api.post('/bookings').set('Idempotency-Key', 'rk-1').send({ slot_id: 'r0', name: 'Ada', email: 'ada@example.com' });
      expect(again.status).toBe(201);
      expect(again.body.id).toBe(first.body.id);
    }
    expect(await attempts('ada@example.com')).toBe(1);
    for (let i = 1; i < 5; i++) expect((await book(i, 'ada@example.com')).status).toBe(201);
  });

  it('a replay still works after the email is rate limited', async () => {
    const first = await api.post('/bookings').set('Idempotency-Key', 'rk-2').send({ slot_id: 'r0', name: 'Ada', email: 'ada@example.com' });
    for (let i = 1; i < 5; i++) await book(i, 'ada@example.com');
    expect((await book(5, 'ada@example.com')).status).toBe(429);
    const replay = await api.post('/bookings').set('Idempotency-Key', 'rk-2').send({ slot_id: 'r0', name: 'Ada', email: 'ada@example.com' });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
  });

  it('a 429 is not stored on the key: a retry after the wait runs fresh', async () => {
    process.env.RATE_LIMIT_WINDOW_SECONDS = '2';
    for (let i = 0; i < 5; i++) await book(i, 'ada@example.com');
    const body = { slot_id: 'r9', name: 'Ada', email: 'ada@example.com' };
    const blocked = await api.post('/bookings').set('Idempotency-Key', 'rk-3').send(body);
    expect(blocked.status).toBe(429);
    const { rows } = await getPool().query("SELECT 1 FROM idempotency_keys WHERE key = 'rk-3'");
    expect(rows).toHaveLength(0);
    await sleep(2100);
    const retry = await api.post('/bookings').set('Idempotency-Key', 'rk-3').send(body);
    expect(retry.status).toBe(201);
    const replay = await api.post('/bookings').set('Idempotency-Key', 'rk-3').send(body);
    expect(replay.body.id).toBe(retry.body.id);
  });

  it('a 422 (same key, different body) does not count as an attempt', async () => {
    await api.post('/bookings').set('Idempotency-Key', 'rk-4').send({ slot_id: 'r0', name: 'Ada', email: 'ada@example.com' });
    for (let i = 0; i < 6; i++) {
      const res = await api.post('/bookings').set('Idempotency-Key', 'rk-4').send({ slot_id: `r${i + 1}`, name: 'Ada', email: 'ada@example.com' });
      expect(res.status).toBe(422);
    }
    expect(await attempts('ada@example.com')).toBe(1);
  });
});

describe('CORS exposes Retry-After', () => {
  it('lets browser pages read the header', async () => {
    const res = await api.get('/slots').set('Origin', 'https://example.org');
    expect(res.headers['access-control-expose-headers']).toMatch(/Retry-After/i);
  });
});
