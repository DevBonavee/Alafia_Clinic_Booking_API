# Alafia Clinic Booking API

A booking API for a small clinic, plus the web page that uses it. Patients see open appointment slots, book one, look up the booking by its link, list their own bookings and cancel them.

It is the Koya assessment, Task 1. The contract follows the official spec at https://koyaacademy.com/assessment-api.

Live: https://alafiaclinicbookingapi-teal.vercel.app. The API endpoints sit at the root (for example `/slots`) and the web page is at `/`.

Stack: Node.js 22, TypeScript, Express, PostgreSQL (Neon in production), hosted on Vercel. The page is plain HTML, CSS and JavaScript with no build step.

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
4. 429 with `Retry-After` (seconds) after 5 attempts for the same email within a minute. Failed attempts count.
5. 400 if `slot_id`, `name` or `email` is missing or empty, or the email is not valid. Name and email are trimmed and the email is stored in lower case.
6. 404 if the slot does not exist, 400 if it has already started.
7. 409 if the slot already has a confirmed booking, otherwise 201 with the booking.

A unique index on confirmed bookings per slot is what stops double booking, so two requests at the same moment cannot both get the slot. Everything (slots, bookings, idempotency keys, rate-limit attempts) lives in Postgres because serverless instances share no memory.

## Run it locally

You need Node.js 22 or newer and Docker.

```sh
npm install
cp .env.example .env          # then set API_KEY in .env
npm run db:up                 # Postgres on localhost:5434, with a clinic_test database for tests
npm run migrate
npm run dev                   # http://localhost:3000
```

Open http://localhost:3000, paste the API key into the key screen, and the page loads the slots. To put some slots in, call `/reset`:

```sh
curl -X POST http://localhost:3000/reset \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"slots":[{"id":"s1","provider":"Dr Ade","start":"2026-12-10T09:00:00Z","end":"2026-12-10T09:30:00Z"}]}'
```

## Tests

```sh
npm test
```

173 tests across five files, one per level, run against the local Docker database. They include 50 simultaneous bookings for one slot (exactly one wins), 10 simultaneous retries with one idempotency key (one booking), and 12 simultaneous attempts from one email (exactly 5 get through).

`scripts/smoke.ts` runs 22 checks covering every level against a running server over HTTP:

```sh
BASE_URL=http://localhost:3000 API_KEY=... npm run smoke
```

It calls `/reset`, so it wipes the target's data. It refuses a non-localhost URL unless you pass `--yes`. When it finishes, it leaves a week of demo slots and no bookings.

## Deploy

The app deploys to Vercel as a zero-config Express project: Vercel finds the default export in `src/app.ts`, and serves `public/` from its CDN.

1. Create a Neon project and copy the pooled connection string (the host contains `-pooler`).
2. Generate an API key, for example with `openssl rand -hex 24`.
3. Put both in `.env.local`, which git ignores, as `DATABASE_URL` and `API_KEY`. Then create the tables on Neon with `npm run migrate:prod`.
4. In Vercel, import the GitHub repo and set `DATABASE_URL` and `API_KEY` as Production environment variables. Deploy.
5. Add `BASE_URL=https://<project>.vercel.app` to `.env.local` and run `npm run smoke:prod`. All 22 checks must pass.

After submitting, leave the deployment alone until the assessors get in touch. Disconnect the Git repository in the Vercel project settings so a later push cannot redeploy it, and don't change the environment variables or the Neon database.
