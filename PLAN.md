# Clinic Booking API: Build Plan

This file is the full brief for building the Koya assessment, Task 1. Drop it in the repo root and give it to Claude Code, for example: "Read PLAN.md and build it level by level. Finish and test each level before starting the next."

The contract below is copied from the official spec at https://koyaacademy.com/assessment-api (OpenAPI 3.0.3, `/assessment-api/openapi.json`, version 1.0). **The spec is the source of truth. If anything here disagrees with it, follow the spec.**

---

## 0. The task

A clinic needs an API that lets patients book appointment slots, plus a simple web page that uses it: see available slots, book one, and see the confirmation. Build both and deploy them at an https URL.

- **Level 1:** List slots, book one, and look up a booking.
- **Level 2:** Only requests with your API key get in, and bookings with missing or invalid details are turned away.
- **Level 3:** Two people can never book the same slot, even at the exact same moment. Bookings can be cancelled.
- **Level 4:** A retried request never creates a duplicate booking, and a person can page through their bookings.
- **Level 5:** Stop anyone from spamming bookings.

Rules: any stack is allowed. Bookings must still be there on the next request, so serverless hosting needs a database. **After submitting, keep it running and don't change it until the assessors make contact.**

---

## 1. Decisions (already made)

| Topic | Decision |
|---|---|
| Language | Node.js 20 + TypeScript |
| Framework | Express |
| Database | PostgreSQL on **Neon** (free plan), using the `pg` driver with Neon's **pooled** connection string |
| Host | **Vercel** (free Hobby plan). Express runs as one Node function and the page is served as a static file from the same project. Vercel is chosen over Render because Render's free tier sleeps after about 15 minutes idle and wakes slowly. |
| Tests | Vitest + Supertest against a local Postgres (Docker), plus `scripts/smoke.ts` that checks the live URL |
| Web page API key | The page has an "API key" input that is saved in `localStorage`. The key is **never** hard-coded in public files. |
| Idempotent replays and the rate limit | A replayed response (same Idempotency-Key, same body) does **not** count as a rate-limit attempt |
| State | Everything lives in Postgres: slots, bookings, idempotency keys and rate-limit attempts. Nothing is kept in memory, because serverless instances aren't shared. |

---

## 2. API contract (exact)

General:
- Everything is JSON (`Content-Type: application/json`).
- **Every error response** is `{"error": "<message>"}`.
- **Every request** needs the `X-API-Key` header. Missing or wrong returns **401**. (Level 2)
- Timestamps are ISO 8601 UTC strings, like `2026-12-10T09:00:00Z`. Output them in exactly this form (no milliseconds) via `toISOString().replace('.000Z','Z')`.

### Schemas

**Slot**
```json
{ "id": "s1", "provider": "Dr Ade", "start": "2026-12-10T09:00:00Z", "end": "2026-12-10T09:30:00Z" }
```
All four fields are required strings. `start` and `end` are date-times.

**SlotWithAvailability** = Slot plus `"available": boolean`. It is `false` while the slot has a confirmed booking.

**NewBooking** (request body)
```json
{ "slot_id": "s1", "name": "Ada Obi", "email": "ada@example.com" }
```

**Booking**
```json
{
  "id": "bk_...",
  "slot_id": "s1",
  "name": "Ada Obi",
  "email": "ada@example.com",
  "status": "confirmed",
  "created_at": "2026-11-15T15:00:00Z"
}
```
`id` is any unique id you generate. `status` is `"confirmed"` or `"cancelled"`. All fields are required.

**Error**
```json
{ "error": "slot not found" }
```

### Endpoints

#### `POST /reset` (Level 1): replace all slots
Deletes every booking and replaces all slots with the ones sent, **including slots in the past**.
- Body: `{"slots": [Slot, ...]}` (required)
- 200: done. Return `{"slots": <count>}`.
- Our choice: 400 if `slots` isn't an array of valid Slot objects. Also clear `idempotency_keys` and `booking_attempts` so every test run starts clean. All of this happens in one transaction.

#### `GET /slots` (Level 1): list slots
- Every slot, **earliest `start` first** (tie-break by `id`).
- Optional query `provider`: only this provider's slots (exact match).
- 200: `{"slots": [SlotWithAvailability, ...]}`

#### `POST /bookings` (Levels 1 to 5): book a slot
- Optional header `Idempotency-Key` (Level 4)
- Body: NewBooking
- **Level 1:** return 201 with the Booking, status `confirmed`.
- **Level 2:**
  - **400** if `slot_id`, `name` or `email` is missing or empty, or the email isn't valid.
  - **404** if the slot doesn't exist.
  - **400** if the slot has already started (`start <= now`).
  - Trim spaces from `name` and `email`, and store `email` in lower case.
- **Level 3:** a slot that already has a confirmed booking returns **409**. This must hold when many requests arrive at the same moment.
- **Level 4:** the same key with the same body returns the same response (same status code, same booking `id`) and never creates a second booking. The same key with a **different** body returns **422**.
- **Level 5:** at most **5 attempts per email per minute, failed attempts included**. The 6th returns **429** with a `Retry-After` header in whole seconds. Other emails aren't affected.
- Responses: 201 Booking, then 400, 404, 409, 422 and 429, each as Error.

#### `GET /bookings` (Level 4): list a person's bookings
- That person's bookings, **oldest first**. The email match ignores case.
- Query `email` (required), `limit` (optional, integer 1 to 50, default 10; **anything else returns 400**), `cursor` (optional).
- Cursor pagination: pass `next_cursor` back as `cursor` to get the next page. **The last page has `next_cursor: null`.**
- 200: `{"bookings": [Booking, ...], "next_cursor": "<string>" | null}`
- 400: invalid limit, and our choice of 400 for a missing email or a malformed cursor.

#### `GET /bookings/{id}` (Level 1): get a booking
- 200 Booking, or 404 if there's no booking with that id.

#### `DELETE /bookings/{id}` (Level 3): cancel a booking
- Sets `status` to `cancelled` and frees the slot.
- 200: the cancelled Booking. 404: no booking with that id. 409: already cancelled.

### Suggested error messages
| Case | Status | `error` |
|---|---|---|
| Missing or wrong key | 401 | `invalid or missing API key` |
| Body not JSON or not an object | 400 | `invalid JSON body` |
| Missing or empty field | 400 | `slot_id is required` (or `name` / `email`) |
| Bad email | 400 | `email is invalid` |
| Slot started | 400 | `slot has already started` |
| Unknown slot | 404 | `slot not found` |
| Slot taken | 409 | `slot already booked` |
| Key reused, different body | 422 | `idempotency key reused with a different body` |
| Rate limited | 429 | `too many booking attempts, try again later` |
| Bad limit | 400 | `limit must be an integer from 1 to 50` |
| Bad cursor | 400 | `invalid cursor` |
| Missing email (list) | 400 | `email is required` |
| Booking not found | 404 | `booking not found` |
| Already cancelled | 409 | `booking already cancelled` |
| Unknown route | 404 | `not found` |
| Unexpected | 500 | `internal error` |

---

## 3. Database schema (`migrations/001_init.sql`)

```sql
CREATE TABLE IF NOT EXISTS slots (
  id        text PRIMARY KEY,
  provider  text NOT NULL,
  start_at  timestamptz NOT NULL,
  end_at    timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  seq        bigserial UNIQUE,                 -- internal: ordering + cursor
  id         text PRIMARY KEY,                 -- e.g. 'bk_' + random
  slot_id    text NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  name       text NOT NULL,
  email      text NOT NULL,                    -- trimmed, lower case
  status     text NOT NULL CHECK (status IN ('confirmed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Level 3: the database guarantees at most ONE confirmed booking per slot
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings(slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_by_email ON bookings(email, seq);

-- Level 4
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           text PRIMARY KEY,
  request_hash  text NOT NULL,
  status_code   int,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Level 5
CREATE TABLE IF NOT EXISTS booking_attempts (
  email text NOT NULL,
  at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_attempts_by_email ON booking_attempts(email, at);
```

Add `npm run migrate`, which runs every file in `migrations/` against `DATABASE_URL`.

---

## 4. Level-by-level implementation

### Level 1
1. Express app in `src/app.ts`, exported as a module (no `listen` there). `src/server.ts` calls `listen` for local dev, and `api/index.ts` exports the app for Vercel.
2. `src/db.ts`: a `pg.Pool` from `DATABASE_URL` (`ssl: { rejectUnauthorized: true }` when the URL needs it, small `max`, for example 5), plus a `withTransaction(fn)` helper.
3. Routes: `POST /reset`, `GET /slots`, `POST /bookings` (plain insert), `GET /bookings/:id`.
4. `available` in GET /slots: `NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status='confirmed')`.
5. Tests: reset, then list (order and the provider filter), then book (201 and shape), then get (200 and 404).

### Level 2
1. Auth middleware before **all** routes: compare `req.get('X-API-Key')` to `process.env.API_KEY` using `crypto.timingSafeEqual` (check the lengths match first). On mismatch return 401 JSON.
2. CORS: allow all origins and the headers `X-API-Key`, `Idempotency-Key` and `Content-Type`. `OPTIONS` preflight returns 204 **without** needing the key.
3. Static page files (`/`, `/index.html`, `/app.js`, `/styles.css`) are served without the key. They are files, not API endpoints.
4. JSON body-parser errors become 400 `{"error":"invalid JSON body"}`. Add a 404 JSON fallback and a 500 JSON error handler.
5. Validation: each field must be `typeof === 'string'` and non-empty after `trim()`. Email regex: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`. Lower-case the email. Then check the slot exists (404), then that `start_at > now()` (400; compare in SQL or with `Date.now()`).
6. Tests: no key and a wrong key on every route (401); each missing, empty or whitespace field; a non-string field; bad emails; an unknown slot; a past slot; and trimming plus lower-casing in the stored booking.

### Level 3
1. The insert relies on the partial unique index. Catch `err.code === '23505'` and return 409 `slot already booked`. **Do not** read and then write to decide availability; the constraint is the guarantee.
2. DELETE: `UPDATE bookings SET status='cancelled' WHERE id=$1 AND status='confirmed' RETURNING *`. If that returns no row, `SELECT` by id: missing is 404, otherwise 409.
3. After cancelling, the slot shows `available: true` and can be booked again (the index only covers confirmed rows).
4. Tests: **50 concurrent POSTs** for one slot (`Promise.all`) give exactly one 201 and 49 responses of 409, and the database holds one confirmed row. Also test cancel then rebook, a double cancel (409) and cancelling an unknown id (404).

### Level 4: idempotency
Run the whole booking inside **one transaction** when a key is present:
1. `hash = sha256(stableStringify(body))`, where the keys are sorted so key order doesn't matter.
2. `INSERT INTO idempotency_keys(key, request_hash) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING RETURNING key`.
3. If no row comes back (the key exists): `SELECT * FROM idempotency_keys WHERE key=$1 FOR UPDATE`. This blocks until a concurrent first request commits.
   - `request_hash` differs: 422.
   - It matches and `status_code` is set: replay `status_code` and `response_body` exactly.
4. If the key is new, run the normal flow (rate limit, validation, insert), then `UPDATE idempotency_keys SET status_code=$, response_body=$`, then commit.
5. Store 201, 400, 404 and 409 results. **Don't store 401 or 429.** For a 429, delete the key row (or roll back) so a later retry runs fresh.
6. A 409 from a unique violation aborts the Postgres transaction, so do the booking insert inside a `SAVEPOINT` (or `INSERT ... ON CONFLICT DO NOTHING RETURNING` and treat no row as 409). Then the response can still be stored on the key row. **Prefer `ON CONFLICT DO NOTHING`**, which avoids the abort entirely. Write it as: `INSERT INTO bookings (...) VALUES (...) ON CONFLICT (slot_id) WHERE status='confirmed' DO NOTHING RETURNING *`.
7. Tests: the same key and body twice give the same status and the same `id`, with one row in the database. Ten concurrent requests with the same key and body create exactly one booking and all return the same id. The same key with a different body gives 422. A replay of a 409 or 400 gives the same status.

### Level 4: pagination (`GET /bookings`)
1. `email` is required. Normalise it with `trim().toLowerCase()`.
2. `limit`: if present it must match `/^\d+$/` and be between 1 and 50, otherwise 400. The default is 10.
3. `cursor`: `base64url(JSON.stringify({s: seq}))`. Decode it and check `s` is an integer, otherwise 400.
4. Query: `WHERE email=$1 AND seq > $cursorSeq ORDER BY seq ASC LIMIT $limit+1`.
5. If `limit+1` rows come back, drop the extra row and set `next_cursor` from the last row returned. Otherwise `next_cursor: null`.
6. Include both confirmed and cancelled bookings, and never return `seq` in the JSON.
7. Tests: with 12 bookings and limit 5, the pages hold 5, 5 and 2, and the last page has `next_cursor: null`. The email matches in mixed case. `limit` of 0, 51, -1, 1.5 or abc returns 400. A garbage cursor returns 400.

### Level 5: rate limit
Inside the booking transaction, **after** the idempotency replay check and **before** validation:
1. If the body has a string `email` that is non-empty after trimming, set `e = email.trim().toLowerCase()`. With no usable email, skip the limiter; the request fails validation with 400 anyway.
2. `SELECT pg_advisory_xact_lock(hashtext($e))` serialises attempts for that one email.
3. `DELETE FROM booking_attempts WHERE email=$e AND at <= now() - interval '60 seconds'`.
4. `SELECT count(*), min(at) FROM booking_attempts WHERE email=$e`.
5. If the count is 5 or more, return 429 with `Retry-After = max(1, ceil(60 - (now - min_at) seconds))` as an integer, and **don't** record this attempt.
6. Otherwise `INSERT INTO booking_attempts(email) VALUES ($e)` and continue. The attempt counts even if validation fails later. Make sure the insert **commits** even when the final response is 400, 404 or 409, which means don't roll back the transaction on those business errors.
7. Tests: five attempts with one email (mix in invalid ones) pass the limiter, and the 6th gives 429 with an integer `Retry-After` of at least 1. A different email still works. Use an injectable clock or a short window env var so the reset can be tested.

### Full order inside `POST /bookings`
1. Auth (401). This is middleware.
2. Parse the JSON body (400).
3. BEGIN
4. Idempotency key: replay or 422, if the header is present.
5. Rate limit by email (429).
6. Validate fields (400).
7. Slot exists (404) and hasn't started (400).
8. Insert with ON CONFLICT DO NOTHING: 201, or 409 if nothing was inserted.
9. Store the response on the idempotency key, if any.
10. COMMIT and send the response.

---

## 5. Web page (`public/`)

Plain HTML, CSS and JS with no build step, served at `/` by the same deployment, calling the API on the same origin.

- **API key bar** at the top: an input plus a Save button, stored in `localStorage`. Every `fetch` sends `X-API-Key`. A 401 shows "Enter a valid API key".
- **Slots:** loads `GET /slots`, groups them by date, shows provider and time in the browser's local timezone, and has a provider filter dropdown. Unavailable slots and past slots are disabled.
- **Booking form:** clicking a free slot opens name and email inputs. On submit, POST /bookings with a fresh `Idempotency-Key` (`crypto.randomUUID()`) **per submit attempt**, reused on automatic retry. The button is disabled while the request is in flight. API errors are shown in plain words, mapped from each status: 400 shows the message, 404 "That slot no longer exists", 409 "Someone just booked this slot", 429 "Too many attempts, try again in N seconds".
- **Confirmation view:** booking id, provider, time, name, email and status, plus a shareable `?booking=<id>` link that loads it via GET /bookings/{id}.
- **My bookings (extra):** enter an email to list it via GET /bookings with a "Load more" button (cursor), and a Cancel button on confirmed bookings (DELETE).
- Make it simple, clean and mobile-friendly.

---

## 6. Project layout

```
api/index.ts            # Vercel entry: export default app
src/app.ts              # Express app, middleware, route mounting
src/server.ts           # local dev: app.listen(PORT)
src/db.ts               # pg Pool + withTransaction
src/auth.ts             # X-API-Key middleware
src/routes/reset.ts
src/routes/slots.ts
src/routes/bookings.ts
src/idempotency.ts
src/rateLimit.ts
src/validate.ts
src/format.ts           # row -> JSON (ISO timestamps without ms)
migrations/001_init.sql
scripts/migrate.ts
scripts/smoke.ts        # BASE_URL + API_KEY -> runs every level against live URL
public/index.html, public/app.js, public/styles.css
tests/level1.test.ts ... tests/level5.test.ts
docker-compose.yml      # local postgres for tests
vercel.json
.env.example            # DATABASE_URL=, API_KEY=
README.md
```

`vercel.json` sketch: serve `public/` statically and send the API paths to the function.
```json
{
  "rewrites": [
    { "source": "/reset", "destination": "/api" },
    { "source": "/slots", "destination": "/api" },
    { "source": "/bookings", "destination": "/api" },
    { "source": "/bookings/:path*", "destination": "/api" }
  ]
}
```
Make sure Express sees the original path (`req.originalUrl`, or check the `x-forwarded` or matched path behaviour on Vercel). Verify this with `vercel dev` before deploying. If rewrites get awkward, routing everything except static files to the function and serving `public/` from Express with `express.static` is fine too. In that case, **register the static route before the auth middleware**.

---

## 7. Build order (finish and test each step before the next)

1. Scaffold the project, local Postgres, migrations and test setup
2. Level 1 and its tests
3. Level 2 and its tests
4. Level 3 and its tests, including the concurrency test
5. Level 4 (idempotency and pagination) and its tests
6. Level 5 and its tests
7. Web page
8. `scripts/smoke.ts`
9. Deploy (section 8), run the smoke test against the live URL, write the README

Commit after each level.

---

## 8. Deployment

1. **GitHub:** push the repo.
2. **Neon** (https://neon.tech, free): create a project and copy the **pooled** connection string (`...-pooler...`, `sslmode=require`).
3. Run the migration against Neon: `DATABASE_URL=<neon url> npm run migrate`.
4. **API key:** generate a long random one, for example `openssl rand -hex 24`. Keep it safe for the submission.
5. **Vercel** (https://vercel.com, sign in with GitHub, Hobby plan): Add New, then Project, then import the repo. In Environment Variables (Production), set `DATABASE_URL` and `API_KEY`, then Deploy.
6. Optional: set the function region close to the Neon region (for example both in `us-east-1` / `iad1`) for speed.
7. Smoke test: `BASE_URL=https://<project>.vercel.app API_KEY=<key> npx tsx scripts/smoke.ts`. Every level must pass.
8. Open the page at the https URL, enter the key, and book, view and cancel once by hand.
9. Submit the **base URL** (API endpoints at its root, for example `https://<project>.vercel.app/slots`) and the **API key**.

No payment details are needed for GitHub, Neon or Vercel free plans.

---

## 9. After submission: freeze

- Run `/reset` and smoke tests **before** submitting, never after.
- In Vercel, go to Project Settings, then Git, and disconnect the repository (or turn on "Ignored Build Step" to skip all builds) so a later push can't redeploy.
- Don't push to main, change env vars, rotate the key, rename the project or domain, or touch the Neon database.
- Keep the Vercel and Neon accounts active until the assessors make contact.

---

## 10. Definition of done

- [ ] All six endpoints match section 2 exactly: paths, status codes, field names and the error shape
- [ ] 401 on every endpoint without the right `X-API-Key`
- [ ] The concurrency test passes: one 201 and the rest 409
- [ ] Idempotency: same key and same body give the same response; same key and different body give 422; concurrent same-key requests create one booking
- [ ] Pagination: oldest first, case-insensitive email, `next_cursor: null` on the last page, limit validation
- [ ] Rate limit: the 6th attempt per email per minute gives 429 with an integer `Retry-After`; other emails are unaffected
- [ ] Data persists across requests (Neon)
- [ ] The web page lists slots, books one and shows the confirmation
- [ ] Deployed at https, the smoke test passes live, and the README has the URL and how to run it
- [ ] Auto-deploy is disabled after submission
