# Alafia Clinic Booking API

A booking API for a small clinic, and the web page that uses it. Patients pick an open appointment slot, book it, get a confirmation with a shareable link, and can list or cancel their bookings later.

This is the Koya assessment, Task 1. The contract follows the official spec at https://koyaacademy.com/assessment-api.

- Web page: https://alafiaclinicbookingapi-teal.vercel.app/
- API base URL: https://alafiaclinicbookingapi-teal.vercel.app (endpoints sit at the root, for example `/slots`)

The API key is not in this repository. The page asks for it once and keeps it in the browser's localStorage.

Stack: Node.js 22, TypeScript, Express and PostgreSQL (Neon in production), hosted on Vercel. The page is plain HTML, CSS and JavaScript with no build step.

## Endpoints

Every request needs an `X-API-Key` header. Requests and responses are JSON, and every error looks like `{"error": "..."}`. Timestamps are UTC in the form `2026-12-10T09:00:00Z`.

| Method | Path | What it does |
|---|---|---|
| POST | `/reset` | Deletes all bookings and replaces the slots with `{"slots": [...]}`. Returns `{"slots": <count>}`. |
| GET | `/slots` | Lists slots, earliest first, each with `available`. Optional `?provider=` (exact match). |
| POST | `/bookings` | Books a slot from `{"slot_id", "name", "email"}`. Optional `Idempotency-Key` header. |
| GET | `/bookings?email=` | One person's bookings, oldest first. `limit` 1 to 50 (default 10) and `cursor` for paging. |
| GET | `/bookings/{id}` | One booking. |
| DELETE | `/bookings/{id}` | Cancels a booking and frees the slot. |

How `POST /bookings` decides its answer, in order:

1. 401 if the API key is missing or wrong.
2. 400 if the body is not a JSON object.
3. With an `Idempotency-Key` that was used before: the same body gets the original response back (same status, same booking id); a different body gets 422.
4. 429 with `Retry-After` (seconds) after 5 attempts for the same email within a minute. Failed attempts count; replays do not.
5. 400 if `slot_id`, `name` or `email` is missing or empty, or the email is not valid. Name and email are trimmed and the email is stored in lower case.
6. 404 if the slot does not exist, 400 if it has already started.
7. 409 if the slot already has a confirmed booking, otherwise 201 with the booking.

A partial unique index allows one confirmed booking per slot, so two requests at the same moment cannot both get it; the insert uses `ON CONFLICT DO NOTHING` and an empty result means 409. The rate limiter takes a per-email advisory lock inside the booking transaction, so parallel attempts are counted one at a time. Slots, bookings, idempotency keys and rate-limit attempts all live in Postgres, because serverless instances share no memory.

## The web page

The design comes from `HANDOFF.md` (brand, fonts, colour tokens, status copy) and `alafia-mockups.html` (the screens). It covers:

- API key entry, with the 401 state.
- Slots by day, filtered by provider. Booked and past slots are disabled.
- A booking form with field errors from the API. On phones it opens as a bottom sheet.
- A "someone just booked this slot" dialog for 409, offering the two nearest open times and keeping the name and email.
- A countdown for 429, read from `Retry-After`.
- A confirmation ticket with a shareable `?booking=<id>` link.
- My bookings: look up by email, page through with "Load more", cancel with an inline confirm.

Each booking submit sends a fresh `Idempotency-Key`, and an automatic retry after a network error reuses it. Times show in the visitor's timezone in 24-hour form.

## Run it locally

You need Node.js 22 or newer and Docker.

```sh
npm install
cp .env.example .env          # then set API_KEY in .env
npm run db:up                 # Postgres on localhost:5434, plus a clinic_test database for tests
npm run migrate
npm run dev                   # http://localhost:3000
```

Open http://localhost:3000 and paste the key from `.env`. The page needs slots to show; add some with `/reset`:

```sh
curl -X POST http://localhost:3000/reset \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"slots":[{"id":"s1","provider":"Dr Ade","start":"2026-12-10T09:00:00Z","end":"2026-12-10T09:30:00Z"}]}'
```

## Tests

```sh
npm test
```

173 tests in five files, one per level, run against the local Docker database. Among them: 50 simultaneous bookings for one slot (exactly one wins), 10 simultaneous retries with one idempotency key (one booking is made), and 12 simultaneous attempts from one email (exactly 5 get through). The rate-limit tests shorten the window with `RATE_LIMIT_WINDOW_SECONDS`; leave that and `RATE_LIMIT_MAX` unset in production.

`scripts/smoke.ts` runs 22 checks covering every level against a running server over HTTP:

```sh
BASE_URL=http://localhost:3000 API_KEY=... npm run smoke
npm run smoke:prod            # reads BASE_URL and API_KEY from .env.local
```

It calls `/reset`, so it wipes the target's data. It refuses a non-localhost URL unless you pass `--yes` (`smoke:prod` passes it). When it finishes it leaves a week of demo slots and no bookings.

## Project layout

```
src/app.ts              Express app (Vercel finds this default export)
src/server.ts           local dev server
src/routes/             reset, slots, bookings
src/auth.ts, cors.ts    API key check, CORS
src/validate.ts         booking body checks
src/idempotency.ts      Idempotency-Key claim, replay, 422
src/rateLimit.ts        5 attempts per email per minute
src/pagination.ts       limit and cursor
migrations/             SQL schema
scripts/                migrate, smoke test
public/                 the web page
tests/                  level1 to level5
```

## Deploy

Vercel runs the app as a zero-config Express project and serves `public/` from its CDN.

1. Create a Neon project and copy the pooled connection string (the host contains `-pooler`).
2. Generate an API key, for example with `openssl rand -hex 24`.
3. Put both in `.env.local` (git ignores it) as `DATABASE_URL` and `API_KEY`, then create the tables on Neon with `npm run migrate:prod`.
4. Import the GitHub repo in Vercel and set `DATABASE_URL` and `API_KEY` as Production environment variables. Variables added after a build only apply after a redeploy.
5. Add `BASE_URL` to `.env.local` and run `npm run smoke:prod`. All 22 checks should pass.

TypeScript is pinned to 5.9.3. Vercel's builder could not resolve `@types/node` with TypeScript 7.

After submitting, leave the deployment alone until the assessors get in touch. Disconnect the Git repository in the Vercel project settings so a later push cannot redeploy it, and don't change the environment variables or the Neon database.
