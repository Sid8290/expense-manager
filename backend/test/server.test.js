'use strict';

// Automated checks for the server, static files and database startup.
// The API tests are in api.test.js. Run everything with:  npm test
//
// Each test that needs a server starts the REAL backend/server.js as a child
// process on a random free port (PORT=0), pointed at:
//   - a throw-away COPY of the frontend plus a few extra test files, and
//   - a throw-away PostgreSQL schema inside the TEST_DATABASE_URL database.
// Your real database and your browser's localStorage are never touched.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TEST_URL, createTestSchema, admin } = require('./helpers/pg-test-db');

const SERVER_JS = path.join(__dirname, '..', 'server.js');
const REAL_FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const IS_WINDOWS = process.platform === 'win32';

const PAGES = {
  '/': 'dashboard',
  '/index.html': 'dashboard',
  '/pages/transactions.html': 'transactions',
  '/pages/categories.html': 'categories',
  '/pages/accounts.html': 'accounts',
  '/pages/analytics.html': 'analytics',
  '/pages/settings.html': 'settings'
};

// ---------------------------------------------------------------------------
// Sandbox: a temp folder holding a copy of the frontend and some bait files.
//
//   <tmp>/secret.txt            outside the web root: must never be reachable
//   <tmp>/frontend/...          copy of the real frontend
//   <tmp>/frontend/assets/pixel.png   stand-in for "an existing asset"
//   <tmp>/frontend/.env         hidden file: must never be served
//   <tmp>/frontend/notes.bak    file type not on the allowlist
//   <tmp>/frontend/escape.txt   symlink pointing outside the root (if allowed)
// ---------------------------------------------------------------------------

const SECRET = 'SECRET-OUTSIDE-ROOT';
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-test-'));
const sandboxFrontend = path.join(tmpRoot, 'frontend');
let symlinkCreated = false;

fs.cpSync(REAL_FRONTEND, sandboxFrontend, { recursive: true });
fs.mkdirSync(path.join(sandboxFrontend, 'assets'), { recursive: true });
fs.writeFileSync(path.join(tmpRoot, 'secret.txt'), SECRET);
fs.writeFileSync(path.join(sandboxFrontend, 'assets', 'pixel.png'), PNG_BYTES);
fs.writeFileSync(path.join(sandboxFrontend, '.env'), 'SECRET-DOTFILE');
fs.writeFileSync(path.join(sandboxFrontend, 'notes.bak'), 'not an allowed type');
try {
  fs.symlinkSync(path.join(tmpRoot, 'secret.txt'), path.join(sandboxFrontend, 'escape.txt'));
  symlinkCreated = true;
} catch (error) {
  // Creating symlinks needs special rights on Windows. Those tests are skipped.
}

// Servers started by these tests share this schema unless a test asks for its own.
let testSchema;

before(async () => {
  testSchema = await createTestSchema();
});

after(async () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  await testSchema.drop();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEnv({ databaseUrl, frontendRoot, env }) {
  const result = {
    ...process.env,
    PORT: '0',
    DATABASE_URL: databaseUrl || testSchema.url,
    FRONTEND_ROOT: frontendRoot === undefined ? sandboxFrontend : frontendRoot,
    ...env
  };
  if (result.FRONTEND_ROOT === null) delete result.FRONTEND_ROOT; // use the server's default
  return result;
}

// Starts the server and resolves once it prints its "running at" line.
function startServer(options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_JS], {
      env: buildEnv(options),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Server did not start in time.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 10000);

    child.stdout.on('data', chunk => {
      stdout += chunk;
      const match = /running at http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]), output: () => ({ stdout, stderr }) });
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early (code ${code}, signal ${signal}).\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
}

// For cases where the server is EXPECTED to refuse to start.
function runUntilExit(options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_JS], {
      env: buildEnv(options),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Server was expected to exit but kept running.\nstdout: ${stdout}`));
    }, 10000);
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// Sends SIGTERM and waits for the process to end on its own.
function stopServer(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return resolve({ code: child.exitCode, signal: child.signalCode });
    }
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.once('exit', (code, signal) => {
      clearTimeout(killTimer);
      resolve({ code, signal });
    });
    child.kill('SIGTERM');
  });
}

// Sends the path EXACTLY as given. (fetch() would tidy "/../" away before
// sending, which would hide the very attacks we want to try.)
function request(port, method, rawPath, { agent = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, agent }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body, text: body.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function parseJson(response) {
  assert.match(response.headers['content-type'], /^application\/json/);
  return JSON.parse(response.text);
}

// ---------------------------------------------------------------------------
// Server behaviour (one shared server for the read-only checks)
// ---------------------------------------------------------------------------

describe('running server', () => {
  let server;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await stopServer(server.child);
  });

  describe('GET /api/health', () => {
    test('returns structured JSON with real server and database status', async () => {
      const response = await request(server.port, 'GET', '/api/health');
      assert.equal(response.status, 200);
      const json = parseJson(response);
      assert.equal(json.ok, true);
      assert.equal(json.data.status, 'ok');
      assert.equal(json.data.server.running, true);
      assert.equal(typeof json.data.server.uptimeSeconds, 'number');
      assert.equal(json.data.database.ready, true);
      assert.equal(json.data.database.engine, 'postgresql');
      assert.equal(json.data.database.schemaVersion, require('../db').LATEST_VERSION);
      assert.match(json.data.database.serverVersion, /^\d+/);
    });

    test('does not leak filesystem paths or connection details', async () => {
      const response = await request(server.port, 'GET', '/api/health');
      assert.ok(!response.text.includes(tmpRoot));
      assert.ok(!/\.db/.test(response.text));
      assert.ok(!response.text.includes('postgres://'));
      assert.ok(!response.text.includes(new URL(TEST_URL).password) || new URL(TEST_URL).password === '');
    });

    test('HEAD returns headers and no body', async () => {
      const response = await request(server.port, 'HEAD', '/api/health');
      assert.equal(response.status, 200);
      assert.equal(response.body.length, 0);
    });
  });

  describe('frontend pages', () => {
    for (const [urlPath, pageName] of Object.entries(PAGES)) {
      test(`GET ${urlPath} serves the ${pageName} page`, async () => {
        const response = await request(server.port, 'GET', urlPath);
        assert.equal(response.status, 200);
        assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
        assert.ok(response.text.includes(`data-page="${pageName}"`));
        assert.ok(response.text.includes('Expense Manager'));
      });
    }
  });

  describe('static assets', () => {
    test('CSS has the right content type', async () => {
      const response = await request(server.port, 'GET', '/css/style.css');
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], 'text/css; charset=utf-8');
      assert.ok(response.text.includes('--background'));
    });

    test('JavaScript has the right content type', async () => {
      const response = await request(server.port, 'GET', '/js/script.js');
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
      assert.ok(response.text.includes('STORAGE_KEYS'));
    });

    test('a file under assets/ is served byte-for-byte as image/png', async () => {
      const response = await request(server.port, 'GET', '/assets/pixel.png');
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], 'image/png');
      assert.deepEqual(response.body, PNG_BYTES);
    });

    test('every local href/src on every page resolves to 200 (existing relative paths work)', async () => {
      for (const pagePath of Object.keys(PAGES)) {
        const html = (await request(server.port, 'GET', pagePath)).text;
        const references = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
          .map(match => match[1])
          .filter(ref => !/^(https?:|#|mailto:)/.test(ref));

        assert.ok(references.length > 0, `${pagePath} should reference local files`);

        for (const reference of references) {
          const target = new URL(reference, `http://localhost${pagePath}`).pathname;
          const response = await request(server.port, 'GET', target);
          assert.equal(response.status, 200, `${pagePath} references ${reference} -> ${target}`);
        }
      }
    });
  });

  describe('unknown routes', () => {
    test('unknown page returns 404 plain text', async () => {
      const response = await request(server.port, 'GET', '/nope.html');
      assert.equal(response.status, 404);
      assert.match(response.headers['content-type'], /^text\/plain/);
    });

    test('unknown API route returns 404 JSON error', async () => {
      const response = await request(server.port, 'GET', '/api/nope');
      assert.equal(response.status, 404);
      const json = parseJson(response);
      assert.equal(json.ok, false);
      assert.equal(json.error.code, 'NOT_FOUND');
    });

    test('bare /api returns 404 JSON error', async () => {
      const response = await request(server.port, 'GET', '/api');
      assert.equal(response.status, 404);
      assert.equal(parseJson(response).error.code, 'NOT_FOUND');
    });

    test('/apixyz is a static path, not an API path', async () => {
      const response = await request(server.port, 'GET', '/apixyz');
      assert.equal(response.status, 404);
      assert.match(response.headers['content-type'], /^text\/plain/);
    });

    test('a folder without index.html returns 404', async () => {
      const response = await request(server.port, 'GET', '/pages');
      assert.equal(response.status, 404);
    });

    test('query strings are ignored for routing', async () => {
      const response = await request(server.port, 'GET', '/pages/transactions.html?search=food');
      assert.equal(response.status, 200);
    });
  });

  describe('unsupported methods', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      test(`${method} /api/health returns 405 JSON with Allow header`, async () => {
        const response = await request(server.port, method, '/api/health');
        assert.equal(response.status, 405);
        assert.match(response.headers.allow, /GET/);
        const json = parseJson(response);
        assert.equal(json.ok, false);
        assert.equal(json.error.code, 'METHOD_NOT_ALLOWED');
      });
    }

    test('POST to a static page returns 405 with Allow: GET, HEAD', async () => {
      const response = await request(server.port, 'POST', '/');
      assert.equal(response.status, 405);
      assert.equal(response.headers.allow, 'GET, HEAD');
    });

    test('POST to an unknown API route is 404, not 405', async () => {
      // (/api/transactions used to be the example here, but it exists since Stage 2.)
      const response = await request(server.port, 'POST', '/api/budgets');
      assert.equal(response.status, 404);
    });
  });

  describe('static file safety', () => {
    // Each path is sent raw. None may return a file; all must be 400 or 404.
    const attacks = [
      '/../secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/pages/../../secret.txt',
      '/pages/%2e%2e/%2e%2e/secret.txt',
      '/..\\secret.txt',
      '/%2e%2e%5csecret.txt',
      '/%252e%252e/secret.txt',
      '/....//secret.txt',
      '/%00',
      '/index.html%00.txt',
      '/%',
      '/%E0%A4%A',
      '/C:/Windows/win.ini',
      '/.env',
      '/.git/config',
      '/%2eenv',
      '/notes.bak'
    ];

    for (const attack of attacks) {
      test(`rejects ${JSON.stringify(attack)}`, async () => {
        const response = await request(server.port, 'GET', attack);
        assert.ok([400, 404].includes(response.status), `expected 400/404, got ${response.status}`);
        assert.ok(!response.text.includes(SECRET), 'outside-root file content leaked');
        assert.ok(!response.text.includes('SECRET-DOTFILE'), 'hidden file content leaked');
      });
    }

    test('rejects a symbolic link that points outside the root', { skip: !symlinkCreated && 'symlinks not permitted here' }, async () => {
      const response = await request(server.port, 'GET', '/escape.txt');
      assert.equal(response.status, 404);
      assert.ok(!response.text.includes(SECRET));
    });

    test('error responses do not reveal stack traces or filesystem paths', async () => {
      for (const attack of ['/../secret.txt', '/%', '/nope.html']) {
        const response = await request(server.port, 'GET', attack);
        assert.ok(!response.text.includes(tmpRoot));
        assert.ok(!/\bat\s+\S+\s+\(/.test(response.text), 'looks like a stack trace');
        assert.ok(response.text.length < 100);
      }
    });

    test('rejects a request target that is not an absolute path', async () => {
      const response = await request(server.port, 'GET', '*');
      assert.equal(response.status, 400);
    });
  });
});

// ---------------------------------------------------------------------------
// Same attacks against the project's REAL folder layout (backend/, package.json
// sit next to frontend/). Confirms server source and config are not reachable.
// ---------------------------------------------------------------------------

describe('real project layout: server source is not exposed', () => {
  let server;

  before(async () => {
    server = await startServer({ frontendRoot: null });
  });

  after(async () => {
    await stopServer(server.child);
  });

  const targets = [
    ['/../backend/server.js', 'createServer'],
    ['/..%2fbackend%2fserver.js', 'createServer'],
    ['/%2e%2e/backend/db.js', 'initDatabase'],
    ['/../package.json', '"name": "expense-manager"'],
    ['/backend/server.js', 'createServer'],
    ['/backend/db.js', 'initDatabase'],
    ['/package.json', '"name": "expense-manager"'],
    ['/backend/data/expense-manager.db', 'SQLite format 3']
  ];

  for (const [target, marker] of targets) {
    test(`${target} does not return project files`, async () => {
      const response = await request(server.port, 'GET', target);
      assert.ok([400, 404].includes(response.status), `expected 400/404, got ${response.status}`);
      assert.ok(!response.body.toString('latin1').includes(marker));
    });
  }

  test('the real dashboard is served from the real frontend folder', async () => {
    const response = await request(server.port, 'GET', '/');
    assert.equal(response.status, 200);
    assert.ok(response.text.includes('data-page="dashboard"'));
  });
});

// ---------------------------------------------------------------------------
// Database module (called directly, in this process)
// ---------------------------------------------------------------------------

describe('db module', () => {
  const db = require('../db');

  // Each test uses its own empty schema and always closes the pool afterwards.
  async function withFreshSchema(work) {
    const schema = await createTestSchema();
    try {
      await work(schema);
    } finally {
      await db.closeDatabase();
      await schema.drop();
    }
  }

  test('reports not ready before initialization', async () => {
    assert.equal((await db.getStatus()).ready, false);
    await assert.rejects(db.query('SELECT 1'), /not initialized/);
    assert.throws(() => db.getPool(), /not initialized/);
  });

  test('initializes, enforces foreign keys, and closes cleanly', async () => {
    await withFreshSchema(async schema => {
      const pool = await db.initDatabase({ connectionString: TEST_URL, schema: schema.schema });
      const status = await db.getStatus();
      assert.equal(status.ready, true);
      assert.equal(status.schemaVersion, db.LATEST_VERSION);
      assert.equal(await db.initDatabase({ connectionString: TEST_URL, schema: schema.schema }), pool, 'second init returns the same pool');

      // Prove foreign keys are really enforced, not just declared.
      await db.query('CREATE TABLE scratch_parent (id INTEGER PRIMARY KEY)');
      await db.query('CREATE TABLE scratch_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES scratch_parent(id))');
      await assert.rejects(db.query('INSERT INTO scratch_child (id, parent_id) VALUES (1, 999)'), /foreign key constraint/);

      await db.closeDatabase();
      assert.equal((await db.getStatus()).ready, false);
      await db.closeDatabase(); // closing twice is safe
    });
  });

  test('does not seed any financial data', async () => {
    await withFreshSchema(async schema => {
      await db.initDatabase({ connectionString: TEST_URL, schema: schema.schema });
      const tables = (await db.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name', [schema.schema]
      )).rows.map(row => row.table_name);
      assert.deepEqual(tables, ['accounts', 'app_meta', 'categories', 'schema_migrations', 'transactions']);
      assert.equal((await db.query('SELECT COUNT(*) AS n FROM app_meta')).rows[0].n, 1);
      for (const table of ['accounts', 'categories', 'transactions']) {
        assert.equal((await db.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n, 0, `${table} is empty`);
      }
    });
  });

  test('re-opening an existing database does not re-run migrations', async () => {
    await withFreshSchema(async schema => {
      const options = { connectionString: TEST_URL, schema: schema.schema };
      await db.initDatabase(options);
      const first = (await db.query("SELECT value FROM app_meta WHERE key = 'created_at'")).rows[0].value;
      await db.closeDatabase();

      await db.initDatabase(options);
      const second = (await db.query("SELECT value FROM app_meta WHERE key = 'created_at'")).rows[0].value;
      const rows = (await db.query('SELECT COUNT(*) AS n FROM app_meta')).rows[0].n;
      assert.equal(second, first);
      assert.equal(rows, 1);
    });
  });

  test('refuses a database created by a newer version of the app', async () => {
    await withFreshSchema(async schema => {
      const options = { connectionString: TEST_URL, schema: schema.schema };
      await db.initDatabase(options);
      await db.query('INSERT INTO schema_migrations (version) VALUES (99)');
      await db.closeDatabase();

      await assert.rejects(db.initDatabase(options), /newer than this app/);
      assert.equal((await db.getStatus()).ready, false);
    });
  });

  test('refuses a connection to a server that is not there', async () => {
    const url = new URL(TEST_URL);
    url.port = '1';
    await assert.rejects(db.initDatabase({ connectionString: url.toString() }), /Cannot connect to PostgreSQL/);
    assert.equal((await db.getStatus()).ready, false);
  });
});

// ---------------------------------------------------------------------------
// Persistence across restarts
// ---------------------------------------------------------------------------

describe('persistence', () => {
  test('the same database survives a restart and is not re-initialized', async () => {
    const own = await createTestSchema();
    const readMeta = async () => {
      const meta = await admin(`SELECT value FROM ${own.schema}.app_meta WHERE key = 'created_at'`);
      const versions = await admin(`SELECT COALESCE(MAX(version), 0) AS version FROM ${own.schema}.schema_migrations`);
      const rows = await admin(`SELECT COUNT(*) AS n FROM ${own.schema}.app_meta`);
      return { createdAt: meta.rows[0].value, version: versions.rows[0].version, rows: Number(rows.rows[0].n) };
    };

    try {
      const first = await startServer({ databaseUrl: own.url });
      await stopServer(first.child);
      const before = await readMeta();

      // Wait one second so a re-created database would get a different timestamp.
      await new Promise(resolve => setTimeout(resolve, 1100));

      const second = await startServer({ databaseUrl: own.url });
      const health = parseJson(await request(second.port, 'GET', '/api/health'));
      await stopServer(second.child);
      const after = await readMeta();

      assert.equal(health.data.database.ready, true);
      assert.equal(after.createdAt, before.createdAt);
      assert.equal(after.version, require('../db').LATEST_VERSION);
      assert.equal(after.rows, 1);
    } finally {
      await own.drop();
    }
  });

  test('records saved through the API are still there after a restart', async () => {
    const own = await createTestSchema();
    try {
      const first = await startServer({ databaseUrl: own.url });
      const created = await fetch(`http://127.0.0.1:${first.port}/api/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'acc-keep', name: 'Kept', type: 'bank', balance: 12.34 })
      });
      assert.equal(created.status, 201);
      await stopServer(first.child);

      const second = await startServer({ databaseUrl: own.url });
      const list = await (await fetch(`http://127.0.0.1:${second.port}/api/accounts`)).json();
      await stopServer(second.child);
      assert.deepEqual(list.data.map(account => [account.id, account.name, account.balance]), [['acc-keep', 'Kept', 12.34]]);
    } finally {
      await own.drop();
    }
  });
});

// ---------------------------------------------------------------------------
// Startup failures must be honest: exit with an error, never pretend to run.
// ---------------------------------------------------------------------------

describe('startup failures', () => {
  test('PostgreSQL not reachable -> exits 1, says why, never reports running', async () => {
    const url = new URL(TEST_URL);
    url.port = '1';

    const result = await runUntilExit({ databaseUrl: url.toString() });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Database initialization failed: Cannot connect to PostgreSQL/);
    assert.ok(!result.stdout.includes('running at'));
  });

  test('wrong password -> exits 1, says why, and never prints the password', async () => {
    const url = new URL(TEST_URL);
    url.password = 'wrong-password-ZQ7';

    const result = await runUntilExit({ databaseUrl: url.toString() });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /rejected the user name or password/);
    assert.ok(!result.stderr.includes('wrong-password-ZQ7') && !result.stdout.includes('wrong-password-ZQ7'));
    assert.ok(!result.stdout.includes('running at'));
  });

  test('DATABASE_URL not set -> exits 1 and explains how to set it', async () => {
    const result = await runUntilExit({ env: { DATABASE_URL: '' } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Database initialization failed: DATABASE_URL is not set/);
    assert.ok(!result.stdout.includes('running at'));
  });

  test('invalid PORT -> exits 1 with a clear message', async () => {
    const result = await runUntilExit({ env: { PORT: 'abc' } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid PORT/);
  });

  test('port already in use -> exits 1 with a clear message', async () => {
    const first = await startServer();
    try {
      const result = await runUntilExit({ env: { PORT: String(first.port) } });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /already in use/);
    } finally {
      await stopServer(first.child);
    }
  });

  test('missing frontend folder -> exits 1 with a clear message', async () => {
    const result = await runUntilExit({ frontendRoot: path.join(tmpRoot, 'does-not-exist') });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Cannot find the frontend folder/);
    assert.ok(!result.stderr.includes(tmpRoot), 'does not print the full filesystem path');
  });
});

// ---------------------------------------------------------------------------
// Shutdown. On Windows, child.kill() ends a process abruptly without running
// its signal handlers, so these can only be checked on Linux/macOS here.
// ---------------------------------------------------------------------------

describe('graceful shutdown', { skip: IS_WINDOWS && 'cannot send POSIX signals to a child on Windows' }, () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    test(`${signal} closes the database and the process exits by itself with code 0`, async () => {
      const server = await startServer();
      const pid = server.child.pid;

      const exited = new Promise(resolve => server.child.once('exit', (code, sig) => resolve({ code, sig })));
      server.child.kill(signal);
      const { code, sig } = await exited;

      assert.equal(code, 0);
      assert.equal(sig, null);
      assert.match(server.output().stdout, /Shutdown complete/);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'process is gone');
    });
  }

  test('an idle keep-alive connection does not block shutdown', async () => {
    const server = await startServer();
    const agent = new http.Agent({ keepAlive: true });
    await request(server.port, 'GET', '/api/health', { agent });

    const started = Date.now();
    const result = await stopServer(server.child);
    agent.destroy();

    assert.equal(result.code, 0);
    assert.ok(Date.now() - started < 4000, 'shut down well before the 5 second force timer');
  });
});
