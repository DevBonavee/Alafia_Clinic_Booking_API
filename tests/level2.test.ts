import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { closePool, getPool } from '../src/db.js';
import { API_KEY, api, inMinutes, reset, sampleSlots } from './helpers.js';

afterAll(closePool);

const UNAUTHORIZED = { error: 'invalid or missing API key' };
const VALID = { slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' };

const routes: Array<[method: 'get' | 'post' | 'delete', path: string, body?: object]> = [
  ['post', '/reset', { slots: sampleSlots() }],
  ['get', '/slots'],
  ['get', '/slots?provider=Dr%20Ade'],
  ['post', '/bookings', VALID],
  ['get', '/bookings?email=ada@example.com'],
  ['get', '/bookings/bk_anything'],
  ['delete', '/bookings/bk_anything'],
  ['get', '/no-such-route'],
];

describe('API key', () => {
  beforeEach(() => reset());

  it.each(routes)('%s %s without a key returns 401', async (method, path, body) => {
    const req = request(app)[method](path);
    const res = body ? await req.send(body) : await req;
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHORIZED);
  });

  it.each(routes)('%s %s with a wrong key returns 401', async (method, path, body) => {
    // (Leading/trailing spaces are not tested: HTTP strips them from header values before the app sees them.)
    for (const key of ['wrong', API_KEY.slice(0, -1) + 'X', API_KEY + 'extra', API_KEY.toUpperCase(), 'x']) {
      const req = request(app)[method](path).set('X-API-Key', key);
      const res = body ? await req.send(body) : await req;
      expect(res.status, `key ${JSON.stringify(key)}`).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED);
    }
  });

  it('a request without a key changes nothing', async () => {
    await request(app).post('/bookings').send(VALID);
    await request(app).post('/reset').send({ slots: [] });
    const { rows } = await getPool().query('SELECT (SELECT count(*) FROM bookings)::int AS b, (SELECT count(*) FROM slots)::int AS s');
    expect(rows[0]).toEqual({ b: 0, s: 4 });
  });

  it('the header name is case-insensitive and the right key works', async () => {
    const res = await request(app).get('/slots').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
  });

  it('rejects everything when API_KEY is not configured', async () => {
    const saved = process.env.API_KEY;
    delete process.env.API_KEY;
    try {
      const res = await request(app).get('/slots').set('X-API-Key', '');
      expect(res.status).toBe(401);
      const res2 = await request(app).get('/slots').set('X-API-Key', 'undefined');
      expect(res2.status).toBe(401);
    } finally {
      process.env.API_KEY = saved;
    }
  });

  it.each(['/', '/index.html', '/app.js', '/styles.css', '/logo.svg'])('serves the page file %s without a key', async (path) => {
    expect((await request(app).get(path)).status).toBe(200);
  });
});

describe('CORS', () => {
  it('answers a preflight with 204 and no key', async () => {
    const res = await request(app)
      .options('/bookings')
      .set('Origin', 'https://example.org')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-api-key, idempotency-key, content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const allowed = res.headers['access-control-allow-headers'].toLowerCase();
    for (const h of ['x-api-key', 'idempotency-key', 'content-type']) expect(allowed).toContain(h);
    expect(res.headers['access-control-allow-methods']).toMatch(/DELETE/);
  });

  it('adds CORS headers to normal and 401 responses', async () => {
    const ok = await api.get('/slots').set('Origin', 'https://example.org');
    expect(ok.headers['access-control-allow-origin']).toBe('*');
    const denied = await request(app).get('/slots').set('Origin', 'https://example.org');
    expect(denied.status).toBe(401);
    expect(denied.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('POST /bookings validation', () => {
  beforeEach(() => reset());

  async function expect400(body: unknown, error: string) {
    const res = await api.post('/bookings').send(body as object);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM bookings');
    expect(rows[0].n).toBe(0);
  }

  for (const field of ['slot_id', 'name', 'email'] as const) {
    it(`rejects a missing ${field}`, async () => {
      const body: Record<string, unknown> = { ...VALID };
      delete body[field];
      await expect400(body, `${field} is required`);
    });
    it.each([
      ['empty', ''],
      ['whitespace', '   \t '],
      ['a number', 42],
      ['null', null],
      ['an array', ['s1']],
      ['an object', { value: 's1' }],
      ['a boolean', true],
    ])(`rejects ${field} that is %s`, async (_label, value) => {
      await expect400({ ...VALID, [field]: value }, `${field} is required`);
    });
  }

  it('reports the first problem in field order', async () => {
    await expect400({}, 'slot_id is required');
    await expect400({ slot_id: 's1' }, 'name is required');
    await expect400({ slot_id: 's1', name: 'Ada', email: 'nope' }, 'email is invalid');
  });

  it.each([
    'plainaddress',
    'ada@',
    '@example.com',
    'ada@example',
    'ada example@example.com',
    'ada@exa mple.com',
    'ada@@example.com',
    'ada@example.',
  ])('rejects the email %j', async (email) => {
    await expect400({ ...VALID, email }, 'email is invalid');
  });

  it.each([
    ['an array', '[]'],
    ['a string', '"hello"'],
    ['a number', '42'],
    ['null', 'null'],
    ['broken JSON', '{"slot_id":'],
  ])('rejects a body that is %s', async (_label, raw) => {
    const res = await api.post('/bookings').set('Content-Type', 'application/json').send(raw);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid JSON body' });
  });

  it('rejects a missing body', async () => {
    const res = await api.post('/bookings');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'slot_id is required' });
  });

  it('parses a JSON body sent without a JSON Content-Type', async () => {
    const res = await api.post('/bookings').set('Content-Type', 'text/plain').send(JSON.stringify(VALID));
    expect(res.status).toBe(201);
    const bad = await api.post('/bookings').set('Content-Type', 'text/plain').send('slot_id=s1');
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'invalid JSON body' });
  });

  it('returns 404 for an unknown slot', async () => {
    const res = await api.post('/bookings').send({ ...VALID, slot_id: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'slot not found' });
  });

  it('checks fields before the slot (bad email on an unknown slot is 400)', async () => {
    await expect400({ ...VALID, slot_id: 'nope', email: 'bad' }, 'email is invalid');
  });

  it('slot ids are matched exactly, not trimmed into another slot', async () => {
    const res = await api.post('/bookings').send({ ...VALID, slot_id: 'S1' });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a slot that already started', async () => {
    await reset([
      { id: 'past', provider: 'Dr Ade', start: inMinutes(-60), end: inMinutes(-30) },
      { id: 'now', provider: 'Dr Ade', start: inMinutes(-1), end: inMinutes(29) },
      { id: 'future', provider: 'Dr Ade', start: inMinutes(60), end: inMinutes(90) },
    ]);
    for (const slot_id of ['past', 'now']) {
      const res = await api.post('/bookings').send({ ...VALID, slot_id });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'slot has already started' });
    }
    expect((await api.post('/bookings').send({ ...VALID, slot_id: 'future' })).status).toBe(201);
  });

  it('trims name and email and stores the email in lower case', async () => {
    const res = await api
      .post('/bookings')
      .send({ slot_id: ' s1 ', name: '  Ada Obi \n', email: '  Ada.OBI@Example.COM\t' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ slot_id: 's1', name: 'Ada Obi', email: 'ada.obi@example.com' });
    const { rows } = await getPool().query('SELECT name, email FROM bookings WHERE id = $1', [res.body.id]);
    expect(rows[0]).toEqual({ name: 'Ada Obi', email: 'ada.obi@example.com' });
    expect((await api.get(`/bookings/${res.body.id}`)).body.email).toBe('ada.obi@example.com');
  });

  it('ignores extra fields', async () => {
    const res = await api.post('/bookings').send({ ...VALID, status: 'cancelled', id: 'bk_mine', extra: 1 });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('confirmed');
    expect(res.body.id).not.toBe('bk_mine');
  });
});
