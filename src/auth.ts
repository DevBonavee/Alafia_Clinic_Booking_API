import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const UNAUTHORIZED = { error: 'invalid or missing API key' };

/**
 * Constant-time key comparison. Both sides are hashed first so the buffers always have
 * equal length and the comparison time does not reveal the real key's length.
 */
function keysMatch(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b) && given.length === expected.length;
}

/** Rejects any request without the right X-API-Key. Fails closed if API_KEY is not configured. */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.API_KEY;
  const given = req.get('X-API-Key');
  if (!expected) {
    console.error('API_KEY is not set; rejecting all API requests');
  }
  if (!expected || !given || !keysMatch(given, expected)) {
    res.status(401).json(UNAUTHORIZED);
    return;
  }
  next();
}
