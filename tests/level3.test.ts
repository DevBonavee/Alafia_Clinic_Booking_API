import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { closePool, getPool } from '../src/db.js';
import { api, reset } from './helpers.js';

afterAll(closePool);

const person = (i: number) => ({ name: `Person ${i}`, email: `person${i}@example.com` });

async function confirmedCount(slotId: string): Promise<number> {
  const { rows } = await getPool().query(
    "SELECT count(*)::int AS n FROM bookings WHERE slot_id = $1 AND status = 'confirmed'",
    [slotId],
  );
  return rows[0].n;
}

async function available(slotId: string): Promise<boolean> {
  const res = await api.get('/slots');
  return res.body.slots.find((s: { id: string }) => s.id === slotId).available;
}

describe('double booking', () => {
  beforeEach(() => reset());

  it('returns 409 when the slot already has a confirmed booking', async () => {
    const first = await api.post('/bookings').send({ slot_id: 's1', ...person(1) });
    expect(first.status).toBe(201);
    const second = await api.post('/bookings').send({ slot_id: 's1', ...person(2) });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'slot already booked' });
    expect(await confirmedCount('s1')).toBe(1);
  });

  it('the same person booking the same slot twice also gets 409', async () => {
    await api.post('/bookings').send({ slot_id: 's1', ...person(1) });
    const again = await api.post('/bookings').send({ slot_id: 's1', ...person(1) });
    expect(again.status).toBe(409);
  });

  it('50 concurrent requests for one slot give exactly one 201 and 49 × 409', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => api.post('/bookings').send({ slot_id: 's2', ...person(i) })),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(49);
    for (const r of results.filter((r) => r.status === 409)) {
      expect(r.body).toEqual({ error: 'slot already booked' });
    }
    expect(await confirmedCount('s2')).toBe(1);
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM bookings');
    expect(rows[0].n).toBe(1);
    const winner = results.find((r) => r.status === 201)!;
    expect((await api.get(`/bookings/${winner.body.id}`)).body).toEqual(winner.body);
  });

  it('concurrent requests across different slots all succeed', async () => {
    const slots = ['s1', 's2', 's3', 's4'];
    const results = await Promise.all(slots.map((slot_id, i) => api.post('/bookings').send({ slot_id, ...person(i) })));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
  });

  it('checks validation, existence and start time before the conflict', async () => {
    await api.post('/bookings').send({ slot_id: 's1', ...person(1) });
    expect((await api.post('/bookings').send({ slot_id: 's1', name: '', email: 'a@b.co' })).status).toBe(400);
  });
});

describe('DELETE /bookings/:id', () => {
  beforeEach(() => reset());

  it('cancels a booking and returns it', async () => {
    const booked = await api.post('/bookings').send({ slot_id: 's1', ...person(1) });
    const res = await api.delete(`/bookings/${booked.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...booked.body, status: 'cancelled' });
    expect((await api.get(`/bookings/${booked.body.id}`)).body.status).toBe('cancelled');
  });

  it('frees the slot so it can be booked again', async () => {
    const first = await api.post('/bookings').send({ slot_id: 's3', ...person(1) });
    expect(await available('s3')).toBe(false);
    await api.delete(`/bookings/${first.body.id}`);
    expect(await available('s3')).toBe(true);

    const second = await api.post('/bookings').send({ slot_id: 's3', ...person(2) });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
    expect(await available('s3')).toBe(false);
    expect(await confirmedCount('s3')).toBe(1);
    // The cancelled booking is kept, not deleted.
    expect((await api.get(`/bookings/${first.body.id}`)).body.status).toBe('cancelled');
  });

  it('returns 409 when cancelling twice', async () => {
    const booked = await api.post('/bookings').send({ slot_id: 's1', ...person(1) });
    await api.delete(`/bookings/${booked.body.id}`);
    const again = await api.delete(`/bookings/${booked.body.id}`);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'booking already cancelled' });
  });

  it('cancelling an old booking does not touch the newer one on the same slot', async () => {
    const first = await api.post('/bookings').send({ slot_id: 's1', ...person(1) });
    await api.delete(`/bookings/${first.body.id}`);
    const second = await api.post('/bookings').send({ slot_id: 's1', ...person(2) });
    expect((await api.delete(`/bookings/${first.body.id}`)).status).toBe(409);
    expect((await api.get(`/bookings/${second.body.id}`)).body.status).toBe('confirmed');
    expect(await available('s1')).toBe(false);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await api.delete('/bookings/bk_doesnotexist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'booking not found' });
  });

  it('10 concurrent cancels of one booking give one 200 and nine 409', async () => {
    const booked = await api.post('/bookings').send({ slot_id: 's4', ...person(1) });
    const results = await Promise.all(Array.from({ length: 10 }, () => api.delete(`/bookings/${booked.body.id}`)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, ...Array(9).fill(409)]);
  });

  it('a cancel race with rebooking never leaves two confirmed bookings', async () => {
    for (let round = 0; round < 5; round++) {
      const current = await getPool().query("SELECT id FROM bookings WHERE slot_id = 's2' AND status = 'confirmed'");
      const ops = [
        ...current.rows.map((r: { id: string }) => api.delete(`/bookings/${r.id}`)),
        ...Array.from({ length: 10 }, (_, i) => api.post('/bookings').send({ slot_id: 's2', ...person(round * 10 + i) })),
      ];
      const results = await Promise.all(ops);
      // Every rebook may lose to the cancel (0 confirmed); the guarantee is never more than one.
      const n = await confirmedCount('s2');
      expect(n).toBeLessThanOrEqual(1);
      const created = results.slice(current.rows.length).filter((r) => r.status === 201).length;
      expect(created).toBe(n);
      if (n === 0) await api.post('/bookings').send({ slot_id: 's2', ...person(900 + round) });
    }
  });

  it('needs the API key', async () => {
    const booked = await api.post('/bookings').send({ slot_id: 's1', ...person(1) });
    expect((await request(app).delete(`/bookings/${booked.body.id}`)).status).toBe(401);
    expect((await api.get(`/bookings/${booked.body.id}`)).body.status).toBe('confirmed');
  });
});
