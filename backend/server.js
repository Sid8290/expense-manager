'use strict';

// HTTP server for the Expense Manager.
//
// It does three jobs:
//   1. Serves the existing frontend (HTML/CSS/JS) from the frontend/ folder.
//   2. Exposes a small JSON API under /api/.
//   3. Starts and stops the SQLite database (see db.js).
//
// Only Node's built-in modules are used: no Express, no npm packages.

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const db = require('./db');

// Everything the static server may serve lives under this folder.
// FRONTEND_ROOT can be overridden, which the automated tests use.
const FRONTEND_ROOT = path.resolve(process.env.FRONTEND_ROOT || path.join(__dirname, '..', 'frontend'));
const HOST = process.env.HOST || '127.0.0.1'; // localhost only: not reachable from other machines

// Only these file types are served. Anything else is treated as not found.
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

// An error that carries the HTTP status we want to answer with.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function send(req, res, status, headers, body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'Content-Length': buffer.length,
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  // A HEAD request gets the same headers as GET but no body.
  res.end(req.method === 'HEAD' ? undefined : buffer);
}

// Every API response has the same shape:
//   success: { "ok": true,  "data": { ... } }
//   failure: { "ok": false, "error": { "code": "...", "message": "..." } }
function sendJson(req, res, status, payload, extraHeaders = {}) {
  send(
    req,
    res,
    status,
    { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
    JSON.stringify(payload)
  );
}

function sendApiError(req, res, status, code, message, extraHeaders = {}) {
  sendJson(req, res, status, { ok: false, error: { code, message } }, extraHeaders);
}

function sendTextError(req, res, status, message, extraHeaders = {}) {
  send(req, res, status, { 'Content-Type': 'text/plain; charset=utf-8', ...extraHeaders }, `${status} ${message}\n`);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// To add an endpoint in a later stage, add a path here with one handler per
// HTTP method. Unknown paths (404) and wrong methods (405) are handled for you.
const apiRoutes = {
  '/api/health': { GET: handleHealth }
};

function handleHealth(req, res) {
  const database = db.getStatus();
  const data = {
    status: database.ready ? 'ok' : 'degraded',
    server: { running: true, uptimeSeconds: Math.round(process.uptime()) },
    database
  };

  if (database.ready) {
    return sendJson(req, res, 200, { ok: true, data });
  }
  sendJson(req, res, 503, {
    ok: false,
    data,
    error: { code: 'DATABASE_NOT_READY', message: 'The database is not ready.' }
  });
}

function handleApi(req, res, pathname) {
  if (!Object.hasOwn(apiRoutes, pathname)) {
    return sendApiError(req, res, 404, 'NOT_FOUND', 'No such API endpoint.');
  }

  const route = apiRoutes[pathname];
  const method = req.method === 'HEAD' ? 'GET' : req.method; // HEAD behaves like GET

  if (!Object.hasOwn(route, method)) {
    return sendApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'This method is not supported for this endpoint.', {
      Allow: Object.keys(route).join(', ')
    });
  }

  return route[method](req, res);
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

function isInside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

// Turns a URL path like "/pages/accounts.html" into a real file path inside
// FRONTEND_ROOT, or throws an HttpError. This is the security-critical part.
async function resolveStaticFile(pathname) {
  // Decode %XX escapes exactly once. "%252e" stays the literal text "%2e".
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (error) {
    throw new HttpError(400, 'Bad Request');
  }

  // Backslashes and colons are path tricks on Windows (e.g. "..\secret",
  // "file.txt::$DATA"). Our files never need them, so refuse them everywhere.
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.includes(':')) {
    throw new HttpError(400, 'Bad Request');
  }

  const segments = decoded.split('/').filter(Boolean);

  if (segments.includes('..')) throw new HttpError(400, 'Bad Request');
  // Hidden names (.git, .env, ...) are never served.
  if (segments.some(segment => segment.startsWith('.'))) throw new HttpError(404, 'Not Found');

  // Layer 1: the lexical check. Joining the segments must stay inside the root.
  const target = path.resolve(FRONTEND_ROOT, ...segments);
  if (!isInside(FRONTEND_ROOT, target)) throw new HttpError(400, 'Bad Request');

  // Layer 2: the real-path check. This resolves symbolic links, so a link
  // inside frontend/ cannot be used to reach a file outside it.
  let realPath;
  let realRoot;
  try {
    realRoot = await fs.realpath(FRONTEND_ROOT);
    realPath = await fs.realpath(target);
  } catch (error) {
    throw new HttpError(404, 'Not Found');
  }
  if (!isInside(realRoot, realPath)) throw new HttpError(404, 'Not Found');

  let stats = await fs.stat(realPath);
  if (stats.isDirectory()) {
    // "/" and other folders serve their index.html.
    realPath = path.join(realPath, 'index.html');
    try {
      stats = await fs.stat(realPath);
    } catch (error) {
      throw new HttpError(404, 'Not Found');
    }
  }

  const contentType = CONTENT_TYPES[path.extname(realPath).toLowerCase()];
  if (!stats.isFile() || !contentType) throw new HttpError(404, 'Not Found');

  return { filePath: realPath, contentType };
}

async function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendTextError(req, res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }

  try {
    const { filePath, contentType } = await resolveStaticFile(pathname);
    const body = await fs.readFile(filePath);
    // no-cache = the browser re-checks each time, so edits show up on refresh.
    send(req, res, 200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' }, body);
  } catch (error) {
    if (error instanceof HttpError) {
      return sendTextError(req, res, error.status, error.message);
    }
    throw error; // unexpected: handled by the catch-all in createServer()
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function createServer() {
  return http.createServer(async (req, res) => {
    // Stage 1 never reads request bodies. Later stages that accept JSON will
    // read the body here instead of discarding it.
    req.resume();

    res.on('finish', () => console.log(`${req.method} ${req.url} -> ${res.statusCode}`));

    // Take the path part of the URL by hand. We avoid `new URL()` because it
    // treats a request like "//host/x" as a different host.
    const rawPath = (req.url || '').split('?')[0].split('#')[0];
    if (!rawPath.startsWith('/')) {
      return sendTextError(req, res, 400, 'Bad Request');
    }

    try {
      if (rawPath === '/api' || rawPath.startsWith('/api/')) {
        return handleApi(req, res, rawPath);
      }
      return await handleStatic(req, res, rawPath);
    } catch (error) {
      // Details go to the server console only, never to the client.
      console.error('Unhandled error while handling request:', error);
      if (res.headersSent) {
        res.destroy();
      } else if (rawPath === '/api' || rawPath.startsWith('/api/')) {
        sendApiError(req, res, 500, 'INTERNAL_ERROR', 'Something went wrong on the server.');
      } else {
        sendTextError(req, res, 500, 'Internal Server Error');
      }
    }
  });
}

function parsePort(value) {
  if (value === undefined || value === '') return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT "${value}". Use a whole number from 0 to 65535.`);
  }
  return port; // 0 means "pick any free port" (used by the tests)
}

// On Ctrl+C (SIGINT) or a stop request (SIGTERM): stop accepting connections,
// let in-flight requests finish, close the database, then let the process end
// naturally. A timer forces exit if something refuses to finish.
function registerShutdown(server) {
  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received. Shutting down...`);

    const forceTimer = setTimeout(() => {
      console.error('Shutdown timed out. Forcing exit.');
      server.closeAllConnections();
      db.closeDatabase();
      process.exit(1);
    }, 5000);
    forceTimer.unref();

    server.close(() => {
      db.closeDatabase();
      console.log('Shutdown complete.');
    });
  }

  // SIGBREAK is what Windows sends when a console window is closed.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.on(signal, () => shutdown(signal));
  }
}

async function start() {
  let port;
  try {
    port = parsePort(process.env.PORT);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  try {
    await fs.access(path.join(FRONTEND_ROOT, 'index.html'));
  } catch (error) {
    console.error('Cannot find the frontend folder (expected frontend/index.html next to backend/).');
    process.exitCode = 1;
    return;
  }

  // If the database cannot start, we stop here. The server never runs while
  // pretending the database is fine.
  try {
    db.initDatabase();
  } catch (error) {
    console.error(`Database initialization failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const server = createServer();

  server.on('error', error => {
    console.error(
      error.code === 'EADDRINUSE'
        ? `Port ${port} is already in use. Stop the other program or set a different PORT.`
        : `Server error: ${error.message}`
    );
    db.closeDatabase();
    process.exitCode = 1;
  });

  // Register the signal handlers BEFORE listening. If they were added after
  // the "running" message, a Ctrl+C arriving in that gap would kill the
  // process with Node's default behaviour and skip the database close.
  registerShutdown(server);

  server.listen(port, HOST, () => {
    console.log(`Expense Manager running at http://${HOST}:${server.address().port}`);
  });
}

// Only start when run directly (node backend/server.js), not when required.
if (require.main === module) {
  start();
}

module.exports = { createServer, start };
