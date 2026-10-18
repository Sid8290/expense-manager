'use strict';

// Automated checks for Stage 1. Run with:  npm test
//
// Each test that needs a server starts the REAL backend/server.js as a child
// process on a random free port (PORT=0), pointed at:
//   - a throw-away COPY of the frontend plus a few extra test files, and
//   - a throw-away SQLite database.
// Your real database and your browser's localStorage are never touched.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

let dbCounter = 0;
function newDbPath() {
  dbCounter += 1;
  return path.join(tmpRoot, 'data', `test-${dbCounter}.db`);
}

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEnv({ dbPath, frontendRoot, env }) {
  const result = {
    ...process.env,
    PORT: '0',
    EXPENSE_DB_PATH: dbPath || newDbPath(),
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
      assert.equal(json.data.database.engine, 'node:sqlite');
      assert.equal(json.data.database.schemaVersion, require('../db').LATEST_VERSION);
      assert.equal(json.data.database.foreignKeys, true);
    });

    test('does not leak filesystem paths', async () => {
      const response = await request(server.port, 'GET', '/api/health');
      assert.ok(!response.text.includes(tmpRoot));
      assert.ok(!/\.db/.test(response.text));
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
      const response = await request(server.port, 'POST', '/api/transactions');
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
  const { DatabaseSync } = require('node:sqlite');

  test('reports not ready before initialization', () => {
    assert.equal(db.getStatus().ready, false);
    assert.throws(() => db.getDb(), /not initialized/);
  });

  test('initializes, enforces foreign keys, and closes cleanly', () => {
    const dbPath = newDbPath();
    const connection = db.initDatabase(dbPath);
    try {
      const status = db.getStatus();
      assert.equal(status.ready, true);
      assert.equal(status.schemaVersion, db.LATEST_VERSION);
      assert.equal(status.foreignKeys, true);
      assert.equal(db.initDatabase(dbPath), connection, 'second init returns the same connection');
      assert.ok(fs.existsSync(dbPath), 'database file was created on disk');

      // Prove foreign keys are really enforced, not just switched on.
      connection.exec(`
        CREATE TABLE scratch_parent (id INTEGER PRIMARY KEY);
        CREATE TABLE scratch_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES scratch_parent(id));
      `);
      assert.throws(
        () => connection.exec('INSERT INTO scratch_child (parent_id) VALUES (999)'),
        /FOREIGN KEY constraint failed/
      );
    } finally {
      db.closeDatabase();
    }

    assert.equal(db.getStatus().ready, false);
    assert.doesNotThrow(() => db.closeDatabase(), 'closing twice is safe');
  });

  test('does not seed any financial data', () => {
    const dbPath = newDbPath();
    const connection = db.initDatabase(dbPath);
    try {
      const tables = connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map(row => row.name);
      assert.deepEqual(tables, ['app_meta']);
      assert.equal(connection.prepare('SELECT COUNT(*) AS n FROM app_meta').get().n, 1);
    } finally {
      db.closeDatabase();
    }
  });

  test('re-opening an existing database does not re-run migrations', () => {
    const dbPath = newDbPath();
    db.initDatabase(dbPath);
    const first = db.getDb().prepare("SELECT value FROM app_meta WHERE key = 'created_at'").get().value;
    db.closeDatabase();

    db.initDatabase(dbPath);
    const second = db.getDb().prepare("SELECT value FROM app_meta WHERE key = 'created_at'").get().value;
    const rows = db.getDb().prepare('SELECT COUNT(*) AS n FROM app_meta').get().n;
    db.closeDatabase();

    assert.equal(second, first);
    assert.equal(rows, 1);
  });

  test('refuses a database created by a newer version of the app', () => {
    const dbPath = newDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA user_version = 99');
    raw.close();

    assert.throws(() => db.initDatabase(dbPath), /newer than this app/);
    assert.equal(db.getStatus().ready, false);
  });

  test('refuses a file that is not a SQLite database', () => {
    const dbPath = newDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'this is definitely not a sqlite database, just some text '.repeat(20));

    assert.throws(() => db.initDatabase(dbPath));
    assert.equal(db.getStatus().ready, false);
  });
});

// ---------------------------------------------------------------------------
// Persistence across restarts
// ---------------------------------------------------------------------------

describe('persistence', () => {
  test('the same database file survives a restart and is not re-initialized', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = newDbPath();

    const readMeta = () => {
      const raw = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return {
          createdAt: raw.prepare("SELECT value FROM app_meta WHERE key = 'created_at'").get().value,
          version: raw.prepare('PRAGMA user_version').get().user_version,
          rows: raw.prepare('SELECT COUNT(*) AS n FROM app_meta').get().n
        };
      } finally {
        raw.close();
      }
    };

    const first = await startServer({ dbPath });
    await stopServer(first.child);
    const before = readMeta();

    // Wait one second so a re-created database would get a different timestamp.
    await new Promise(resolve => setTimeout(resolve, 1100));

    const second = await startServer({ dbPath });
    const health = parseJson(await request(second.port, 'GET', '/api/health'));
    await stopServer(second.child);
    const after = readMeta();

    assert.equal(health.data.database.ready, true);
    assert.equal(after.createdAt, before.createdAt);
    assert.equal(after.version, 1);
    assert.equal(after.rows, 1);
  });
});

// ---------------------------------------------------------------------------
// Startup failures must be honest: exit with an error, never pretend to run.
// ---------------------------------------------------------------------------

describe('startup failures', () => {
  test('database path is a directory -> exits 1, says why, never reports running', async () => {
    const dirAsDb = path.join(tmpRoot, 'a-directory');
    fs.mkdirSync(dirAsDb, { recursive: true });

    const result = await runUntilExit({ dbPath: dirAsDb });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Database initialization failed/);
    assert.ok(!result.stdout.includes('running at'));
  });

  test('database file is corrupt -> exits 1, says why, never reports running', async () => {
    const corrupt = path.join(tmpRoot, 'corrupt.db');
    fs.writeFileSync(corrupt, 'not a database '.repeat(100));

    const result = await runUntilExit({ dbPath: corrupt });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Database initialization failed/);
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
