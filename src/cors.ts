import type { NextFunction, Request, Response } from 'express';

/** Allows any origin. Preflight (OPTIONS) answers 204 without needing the API key. */
export function cors(req: Request, res: Response, next: NextFunction): void {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'X-API-Key, Idempotency-Key, Content-Type',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400',
  });
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}
