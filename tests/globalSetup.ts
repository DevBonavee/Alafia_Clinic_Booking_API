// Applies migrations to the test database once before any test file runs.
import { TEST_DATABASE_URL } from './setupEnv.js';

export default async function setup() {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const { migrate } = await import('../scripts/migrate.js');
  const { closePool } = await import('../src/db.js');
  try {
    await migrate();
  } catch (err) {
    throw new Error(
      `Could not migrate the test database at ${TEST_DATABASE_URL}. Is it running? Try "npm run db:up". (${(err as Error).message})`,
    );
  } finally {
    await closePool();
  }
}
