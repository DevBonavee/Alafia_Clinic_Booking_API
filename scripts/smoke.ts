// Smoke test: checks every level against a running deployment.
//
//   BASE_URL=https://<project>.vercel.app API_KEY=<key> npx tsx scripts/smoke.ts --yes
//
// WARNING: this calls POST /reset, which deletes every booking and replaces all slots on the
// target. It refuses to run against a non-localhost URL unless you pass --yes.
// When it finishes it leaves a fresh set of demo slots (no bookings) so the web page has data.

const BASE_URL = (process.env.BASE_URL ?? '').replace(/\/+$/, '');
const API_KEY = process.env.API_KEY ?? '';

if (!BASE_URL || !API_KEY) {
  console.error('Set BASE_URL and API_KEY, e.g. BASE_URL=http://localhost:3000 API_KEY=... npx tsx scripts/smoke.ts');
  process.exit(2);
}
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE_URL);
if (!isLocal && !process.argv.includes('--yes')) {
  console.error(`This wipes all data at ${BASE_URL} (POST /reset). Re-run with --yes to confirm.`);
  process.exit(2);
}

// ---------- tiny HTTP + assertion helpers ----------
interface Res {
  status: number;
  body: any;
  headers: Headers;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; key?: string | null; headers?: Record<string, string> } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  const key = opts.key === undefined ? API_KEY : opts.key;
  if (key !== null) headers['X-API-Key'] = key;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE_URL + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, headers: res.headers };
}

class Fail extends Error {}
function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Fail(message);
}
function expectStatus(res: Res, status: number, what: string) {
  expect(res.status === status, `${what}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
}
function expectError(res: Res, status: number, error: string, what: string) {
  expectStatus(res, status, what);
  expect(res.body?.error === error, `${what}: expected error ${JSON.stringify(error)}, got ${JSON.stringify(res.body)}`);
}

let passed = 0;
const failures: string[] = [];
let section = '';
async function check(name: string, fn: () => Promise<void>) {
  const label = `${section} › ${name}`;
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    const msg = err instanceof Fail ? err.message : `unexpected: ${(err as Error).stack ?? err}`;
    failures.push(`${label}: ${msg}`);
    console.log(`  FAIL  ${name}\n        ${msg}`);
  }
}
function heading(title: string) {
  section = title;
  console.log(`\n${title}`);
}

// ---------- test data ----------
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const minute = 60_000;
const base = Math.ceil(Date.now() / (30 * minute)) * 30 * minute + 24 * 60 * minute; // tomorrow, on a half hour
const slot = (id: string, provider: string, offsetMin: number) => ({
  id,
  provider,
  start: iso(new Date(base + offsetMin * minute)),
  end: iso(new Date(base + (offsetMin + 30) * minute)),
});
const providers = ['Dr Ade', 'Dr Bello', 'Dr Chen'];
const SLOTS = [
  { id: 'past', provider: 'Dr Ade', start: iso(new Date(Date.now() - 120 * minute)), end: iso(new Date(Date.now() - 90 * minute)) },
  ...Array.from({ length: 40 }, (_, i) => slot(`t${String(i).padStart(2, '0')}`, providers[i % 3], i * 30)),
];
// Same start time, ids out of order: checks the id tie-break.
SLOTS.push({ ...slot('tie-b', 'Dr Bello', 40 * 30), id: 'tie-b' }, { ...slot('tie-a', 'Dr Ade', 40 * 30), id: 'tie-a' });

const run = Date.now().toString(36);
const email = (tag: string) => `smoke-${tag}-${run}@example.com`;
let n = 0;
const nextSlot = () => `t${String(n++).padStart(2, '0')}`;

// ---------- the checks ----------
async function main() {
  console.log(`Smoke test against ${BASE_URL}`);

  heading('Level 1: reset, list, book, look up');
  await check('POST /reset replaces slots and returns the count', async () => {
    const res = await call('POST', '/reset', { body: { slots: SLOTS } });
    expectStatus(res, 200, 'reset');
    expect(res.body?.slots === SLOTS.length, `reset count: ${JSON.stringify(res.body)}`);
  });
  await check('GET /slots lists every slot earliest first (id breaks ties) with availability', async () => {
    const res = await call('GET', '/slots');
    expectStatus(res, 200, 'slots');
    const list = res.body.slots as Array<Record<string, unknown>>;
    expect(list.length === SLOTS.length, `expected ${SLOTS.length} slots, got ${list.length}`);
    expect(list[0].id === 'past', 'past slot should come first');
    const tie = list.slice(-2).map((s) => s.id).join(',');
    expect(tie === 'tie-a,tie-b', `tie-break by id: got ${tie}`);
    for (const s of list) {
      expect(Object.keys(s).sort().join() === 'available,end,id,provider,start', `slot shape: ${JSON.stringify(s)}`);
      expect(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(String(s.start)), `start format: ${s.start}`);
      expect(s.available === true, `slot ${s.id} should be available`);
    }
  });
  await check('GET /slots?provider= filters by exact provider', async () => {
    const res = await call('GET', '/slots?provider=' + encodeURIComponent('Dr Chen'));
    expectStatus(res, 200, 'filter');
    expect(res.body.slots.length > 0 && res.body.slots.every((s: any) => s.provider === 'Dr Chen'), 'only Dr Chen');
    const none = await call('GET', '/slots?provider=dr%20chen');
    expect(none.body.slots.length === 0, 'match is case-sensitive/exact');
  });
  let firstBooking: any;
  await check('POST /bookings returns 201 with a confirmed Booking', async () => {
    const res = await call('POST', '/bookings', { body: { slot_id: nextSlot(), name: 'Ada Obi', email: email('l1') } });
    expectStatus(res, 201, 'book');
    expect(
      Object.keys(res.body).sort().join() === 'created_at,email,id,name,slot_id,status',
      `booking shape: ${JSON.stringify(res.body)}`,
    );
    expect(res.body.status === 'confirmed', 'status confirmed');
    firstBooking = res.body;
  });
  await check('GET /bookings/{id} returns it (it persisted), unknown id is 404', async () => {
    const res = await call('GET', `/bookings/${firstBooking?.id}`);
    expectStatus(res, 200, 'get');
    expect(JSON.stringify(res.body) === JSON.stringify(firstBooking), 'same booking');
    expectError(await call('GET', '/bookings/bk_does_not_exist'), 404, 'booking not found', 'unknown id');
  });
  await check('the booked slot shows available: false', async () => {
    const res = await call('GET', '/slots');
    const s = res.body.slots.find((x: any) => x.id === firstBooking?.slot_id);
    expect(s && s.available === false, 'slot unavailable');
  });

  heading('Level 2: API key and validation');
  await check('every route returns 401 without a key or with a wrong key', async () => {
    const routes: Array<[string, string, unknown?]> = [
      ['POST', '/reset', { slots: [] }],
      ['GET', '/slots'],
      ['POST', '/bookings', { slot_id: 't39', name: 'X', email: 'x@example.com' }],
      ['GET', '/bookings?email=x@example.com'],
      ['GET', `/bookings/${firstBooking?.id}`],
      ['DELETE', `/bookings/${firstBooking?.id}`],
    ];
    for (const [method, path, body] of routes) {
      for (const key of [null, 'wrong-key']) {
        expectError(await call(method, path, { body, key }), 401, 'invalid or missing API key', `${method} ${path} key=${key}`);
      }
    }
    const still = await call('GET', `/bookings/${firstBooking?.id}`);
    expect(still.body?.status === 'confirmed', 'unauthenticated DELETE must not cancel');
  });
  await check('CORS preflight is 204 without a key; the page loads without a key', async () => {
    const pre = await fetch(BASE_URL + '/bookings', {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-api-key,content-type' },
    });
    expect(pre.status === 204, `preflight status ${pre.status}`);
    expect(pre.headers.get('access-control-allow-origin') === '*', 'allow-origin *');
    const page = await fetch(BASE_URL + '/');
    expect(page.status === 200 && (await page.text()).includes('alafia'), `page status ${page.status}`);
  });
  await check('missing, empty and non-string fields are 400', async () => {
    for (const field of ['slot_id', 'name', 'email'] as const) {
      for (const [i, bad] of [undefined, '', '   ', 42].entries()) {
        // A fresh email per request, so the Level 5 limiter never answers before validation does.
        const good = { slot_id: 't39', name: 'Ada', email: email(`l2-${field}-${i}`) };
        const body: Record<string, unknown> = { ...good, [field]: bad };
        if (bad === undefined) delete body[field];
        expectError(await call('POST', '/bookings', { body }), 400, `${field} is required`, `${field}=${JSON.stringify(bad)}`);
      }
    }
  });
  await check('invalid email is 400, bad JSON is 400', async () => {
    expectError(
      await call('POST', '/bookings', { body: { slot_id: 't39', name: 'Ada', email: 'not-an-email' } }),
      400,
      'email is invalid',
      'bad email',
    );
    const raw = await fetch(BASE_URL + '/bookings', {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: '{"slot_id":',
    });
    expect(raw.status === 400, `bad JSON status ${raw.status}`);
  });
  await check('unknown slot is 404, a started slot is 400', async () => {
    expectError(await call('POST', '/bookings', { body: { slot_id: 'nope', name: 'Ada', email: email('l2b') } }), 404, 'slot not found', 'unknown slot');
    expectError(await call('POST', '/bookings', { body: { slot_id: 'past', name: 'Ada', email: email('l2c') } }), 400, 'slot has already started', 'past slot');
  });
  await check('name and email are trimmed, email stored lower case', async () => {
    const res = await call('POST', '/bookings', { body: { slot_id: nextSlot(), name: '  Ada Obi ', email: `  ${email('TRIM').toUpperCase()} ` } });
    expectStatus(res, 201, 'book');
    expect(res.body.name === 'Ada Obi', `name ${JSON.stringify(res.body.name)}`);
    expect(res.body.email === email('trim'), `email ${JSON.stringify(res.body.email)}`);
  });

  heading('Level 3: no double booking, cancellation');
  const raceSlot = nextSlot();
  await check('20 simultaneous bookings for one slot give one 201 and 19 × 409', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => call('POST', '/bookings', { body: { slot_id: raceSlot, name: `R${i}`, email: email(`race${i}`) } })),
    );
    const s = results.map((r) => r.status);
    const ok = s.filter((x) => x === 201).length;
    const conflict = results.filter((r) => r.status === 409 && r.body?.error === 'slot already booked').length;
    expect(ok === 1 && conflict === 19, `got ${ok}×201, ${conflict}×409 (all: ${s.join(',')})`);
  });
  await check('DELETE cancels (200), a second DELETE is 409, unknown is 404', async () => {
    const booked = await call('POST', '/bookings', { body: { slot_id: nextSlot(), name: 'Ada', email: email('l3') } });
    expectStatus(booked, 201, 'book');
    const del = await call('DELETE', `/bookings/${booked.body.id}`);
    expectStatus(del, 200, 'cancel');
    expect(del.body.status === 'cancelled' && del.body.id === booked.body.id, 'cancelled booking returned');
    expectError(await call('DELETE', `/bookings/${booked.body.id}`), 409, 'booking already cancelled', 'cancel twice');
    expectError(await call('DELETE', '/bookings/bk_does_not_exist'), 404, 'booking not found', 'cancel unknown');
    const again = await call('POST', '/bookings', { body: { slot_id: booked.body.slot_id, name: 'Bo', email: email('l3b') } });
    expectStatus(again, 201, 'rebook freed slot');
  });

  heading('Level 4: idempotency and pagination');
  await check('same Idempotency-Key and body: same status and id, one booking', async () => {
    const key = `smoke-${run}-a`;
    const body = { slot_id: nextSlot(), name: 'Ada', email: email('idem') };
    const a = await call('POST', '/bookings', { body, headers: { 'Idempotency-Key': key } });
    const b = await call('POST', '/bookings', { body: { email: body.email, name: body.name, slot_id: body.slot_id }, headers: { 'Idempotency-Key': key } });
    expectStatus(a, 201, 'first');
    expectStatus(b, 201, 'replay');
    expect(a.body.id === b.body.id, 'same id');
    const list = await call('GET', `/bookings?email=${encodeURIComponent(body.email)}`);
    expect(list.body.bookings.length === 1, `one booking, got ${list.body.bookings.length}`);
  });
  await check('same key with a different body is 422', async () => {
    const key = `smoke-${run}-b`;
    await call('POST', '/bookings', { body: { slot_id: nextSlot(), name: 'Ada', email: email('idem2') }, headers: { 'Idempotency-Key': key } });
    const res = await call('POST', '/bookings', { body: { slot_id: nextSlot(), name: 'Ada', email: email('idem2') }, headers: { 'Idempotency-Key': key } });
    expectError(res, 422, 'idempotency key reused with a different body', 'different body');
  });
  await check('10 simultaneous retries with one key create one booking', async () => {
    const key = `smoke-${run}-c`;
    const body = { slot_id: nextSlot(), name: 'Ada', email: email('idem3') };
    const results = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/bookings', { body, headers: { 'Idempotency-Key': key } })));
    expect(results.every((r) => r.status === 201), `statuses ${results.map((r) => r.status).join(',')}`);
    expect(new Set(results.map((r) => r.body.id)).size === 1, 'one id');
  });
  await check('pagination: 5 bookings at limit 2 come back 2, 2, 1, oldest first, then null', async () => {
    const who = email('pages');
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/bookings', { body: { slot_id: nextSlot(), name: 'Pat', email: who } });
      expectStatus(r, 201, `booking ${i}`);
      made.push(r.body.id);
    }
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const q = `/bookings?email=${encodeURIComponent(who.toUpperCase())}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await call('GET', q);
      expectStatus(res, 200, `page ${page}`);
      sizes.push(res.body.bookings.length);
      seen.push(...res.body.bookings.map((b: any) => b.id));
      cursor = res.body.next_cursor;
      if (cursor === null) break;
    }
    expect(sizes.join() === '2,2,1', `page sizes ${sizes.join()}`);
    expect(seen.join() === made.join(), 'oldest first, nothing missing or repeated');
    expect(cursor === null, 'last page next_cursor null');
  });
  await check('bad limit, bad cursor and missing email are 400', async () => {
    for (const limit of ['0', '51', '-1', '1.5', 'abc']) {
      expectError(await call('GET', `/bookings?email=a@b.co&limit=${limit}`), 400, 'limit must be an integer from 1 to 50', `limit=${limit}`);
    }
    expectError(await call('GET', '/bookings?email=a@b.co&cursor=garbage!!'), 400, 'invalid cursor', 'cursor');
    expectError(await call('GET', '/bookings'), 400, 'email is required', 'no email');
  });

  heading('Level 5: rate limit');
  await check('5 attempts per email per minute (failures count), the 6th is 429 with Retry-After', async () => {
    const who = email('limit');
    const statuses: number[] = [];
    statuses.push((await call('POST', '/bookings', { body: { slot_id: 'nope', name: 'Lim', email: who } })).status); // 404 counts
    statuses.push((await call('POST', '/bookings', { body: { slot_id: 'past', name: 'Lim', email: who } })).status); // 400 counts
    for (let i = 0; i < 3; i++) {
      statuses.push((await call('POST', '/bookings', { body: { slot_id: nextSlot(), name: 'Lim', email: who } })).status);
    }
    expect(statuses.join() === '404,400,201,201,201', `first five: ${statuses.join()}`);
    const sixth = await call('POST', '/bookings', { body: { slot_id: nextSlot(), name: 'Lim', email: who.toUpperCase() } });
    expectError(sixth, 429, 'too many booking attempts, try again later', '6th attempt');
    const ra = sixth.headers.get('retry-after') ?? '';
    expect(/^\d+$/.test(ra) && Number(ra) >= 1 && Number(ra) <= 60, `Retry-After ${JSON.stringify(ra)}`);
  });
  await check('another email is not affected', async () => {
    const res = await call('POST', '/bookings', { body: { slot_id: nextSlot(), name: 'Other', email: email('other') } });
    expectStatus(res, 201, 'other email');
  });

  heading('Clean up');
  await check('reset to demo slots for the web page', async () => {
    const res = await call('POST', '/reset', { body: { slots: demoSlots() } });
    expectStatus(res, 200, 'reset');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

/** Weekday mornings for the next week: 9:00–12:00 UTC, 30-minute slots, three providers. */
function demoSlots() {
  const out: Array<{ id: string; provider: string; start: string; end: string }> = [];
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  let added = 0;
  for (let d = 1; added < 5 && d < 14; d++) {
    const date = new Date(day.getTime() + d * 24 * 60 * minute);
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    added++;
    const ymd = date.toISOString().slice(0, 10);
    for (let k = 0; k < 6; k++) {
      const start = new Date(date.getTime() + (9 * 60 + k * 30) * minute);
      const provider = providers[k % 3];
      out.push({
        id: `${ymd}-${String(start.getUTCHours()).padStart(2, '0')}${String(start.getUTCMinutes()).padStart(2, '0')}-${provider.split(' ')[1].toLowerCase()}`,
        provider,
        start: iso(start),
        end: iso(new Date(start.getTime() + 30 * minute)),
      });
    }
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
