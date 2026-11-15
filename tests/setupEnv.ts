// Points the app at the test database. Override with TEST_DATABASE_URL.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5434/clinic_test';

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.API_KEY = process.env.API_KEY_FOR_TESTS ?? 'test-key-0123456789';
