'use strict';

// Shared helper for tests that need a real PostgreSQL database.
//
// It reads TEST_DATABASE_URL (a database used ONLY for testing; see
// .env.example) and gives each test file its own throw-away schema
// (em_test_<random>), so tests never touch your real tables and never see each
// other's data. Call drop() when the file is finished.
//
// The URL it returns selects that schema through the standard `options`
// connection parameter, so it also works for servers started as separate
// processes (set it as their DATABASE_URL).

const crypto = require('node:crypto');
const { Client } = require('pg');

const TEST_URL = process.env.TEST_DATABASE_URL;

function databaseName(url) {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

// Safety checks. They stop the whole test file before anything is created.
if (!TEST_URL) {
  throw new Error(
    'TEST_DATABASE_URL is not set. These tests need a PostgreSQL database used ONLY for testing, ' +
      'for example postgres://expense_user:PASSWORD@127.0.0.1:5432/expense_manager_test (see .env.example).'
  );
}
if (!/test/i.test(databaseName(TEST_URL))) {
  throw new Error(`Refusing to run: the TEST_DATABASE_URL database name "${databaseName(TEST_URL)}" does not contain "test".`);
}
if (process.env.DATABASE_URL && process.env.DATABASE_URL === TEST_URL) {
  throw new Error('Refusing to run: TEST_DATABASE_URL is the same as DATABASE_URL.');
}

async function admin(sql) {
  const client = new Client({ connectionString: TEST_URL });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

// Creates a new empty schema. Returns { schema, url, drop }.
async function createTestSchema() {
  const schema = `em_test_${crypto.randomBytes(6).toString('hex')}`;
  await admin(`CREATE SCHEMA ${schema}`);

  const url = new URL(TEST_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);

  return {
    schema,
    url: url.toString(),
    drop: () => admin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  };
}

module.exports = { TEST_URL, createTestSchema, admin };
