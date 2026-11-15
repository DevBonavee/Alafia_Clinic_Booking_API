import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { requireApiKey } from './auth.js';
import { cors } from './cors.js';
import { HttpError } from './http.js';
import { bookingsRouter } from './routes/bookings.js';
import { resetRouter } from './routes/reset.js';
import { slotsRouter } from './routes/slots.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export const app = express();

app.disable('x-powered-by');
app.set('etag', false);

app.use(cors);

// The web page's files are not API endpoints, so they are served before the key check.
// Locally Express serves them; on Vercel, public/ is served by the CDN and this line is ignored.
app.use(express.static(publicDir));

// Everything below needs the API key, including unknown routes.
app.use(requireApiKey);

// The API only speaks JSON, so bodies are parsed as JSON even if the client forgot the Content-Type header.
app.use(express.json({ limit: '100kb', type: () => true }));

app.use(resetRouter);
app.use(slotsRouter);
app.use(bookingsRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'not found' });
});

// Every error leaves as {"error": "..."}; unexpected ones never leak details.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const e = err as { type?: string };
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'invalid JSON body' });
    return;
  }
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: 'request body too large' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

export default app;
