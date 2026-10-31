'use strict';

// HTTP server for the Expense Manager, built on Express.
//
// It does three jobs:
//   1. Serves the existing frontend (HTML/CSS/JS) from the frontend/ folder.
//   2. Exposes a small JSON API under /api/.
//   3. Starts and stops the PostgreSQL connection pool (see db.js).
//
// The API routes are still the plain table below (path -> { METHOD: handler }),
// so the handlers in backend/api/ did not have to change shape: each one
// receives { req, params, body } and returns { status, payload, headers? }.
// The code here registers that table with Express and keeps every response
// exactly as the API documentation describes it (JSON envelope, error codes,
// 404/405 answers, body limits).

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');

const db = require('./db');
const { describeConstraintError } = require('./db-errors');
const { ApiError, ok } = require('./api/common');

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

function sendApiError(req, res, status, code, message, extraHeaders = {}, details) {
  const error = { code, message };
  if (details) error.details = details;
  sendJson(req, res, status, { ok: false, error }, extraHeaders);
}

function sendTextError(req, res, status, message, extraHeaders = {}) {
  send(req, res, status, { 'Content-Type': 'text/plain; charset=utf-8', ...extraHeaders }, `${status} ${message}\n`);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// Maps a path to { METHOD: handler }. A ":name" segment matches any single
// non-empty value and is passed to the handler in `params`. To add an
// endpoint, add a path here (or in a module under backend/api/). Unknown paths
// (404) and wrong methods (405) are handled for you.
//
// A handler receives { req, params, body } and returns { status, payload,
// headers? } (see ok() in api/common.js), or throws an ApiError. It never
// touches `res`: the code below sends the response.
const apiRoutes = {
  '/api/health': { GET: handleHealth },
  ...require('./api/accounts').routes,
  ...require('./api/categories').routes,
  ...require('./api/transactions').routes,
  ...require('./api/importer').routes,
  ...require('./api/exporter').routes
};

async function handleHealth() {
  const database = await db.getStatus();
  const data = {
    status: database.ready ? 'ok' : 'degraded',
    server: { running: true, uptimeSeconds: Math.round(process.uptime()) },
    database
  };

  if (database.ready) {
    return ok(data);
  }
  return {
    status: 503,
    payload: {
      ok: false,
      data,
      error: { code: 'DATABASE_NOT_READY', message: 'The database is not ready.' }
    }
  };
}

// The path part of the URL, taken by hand. We avoid `new URL()` because it
// treats a request like "//host/x" as a different host.
function rawPathOf(req) {
  return (req.url || '').split('?')[0].split('#')[0];
}

function isApiPath(req) {
  const rawPath = rawPathOf(req);
  return rawPath === '/api' || rawPath.startsWith('/api/');
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1024; // far more than any single record needs
// A handler can allow a larger body by setting `handler.maxBodyBytes` (only the
// import endpoints will, because they receive a whole backup at once).

// Requiring application/json also means a web page on another site cannot
// make the browser send us a "simple" cross-site request (it would need a
// CORS preflight, which this server never approves). Checked BEFORE the body
// is read, so a wrong type is answered without reading it.
function requireJsonContentType(req, res, next) {
  const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the body as application/json.'));
  }
  next();
}

// After express.json() has read and parsed the body: it must be a JSON object.
function requireJsonObject(req, res, next) {
  const body = req.body;
  // express.json() turns a completely empty body into {}; an empty body is an error here.
  if (body === undefined || req.bodyWasEmpty) {
    return next(new ApiError(400, 'INVALID_JSON', 'The request body is empty.'));
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return next(new ApiError(400, 'INVALID_BODY', 'The request body must be a JSON object.'));
  }
  next();
}

// The middleware that reads the body of a POST or PUT, in order. express.json()
// does the reading, the size limit and the parsing; `strict: false` lets it
// accept any JSON value so that "[]" or "null" get OUR message (INVALID_BODY)
// instead of a generic parse error, and `type: () => true` because the content
// type was already checked above.
function bodyMiddleware(handler) {
  return [
    requireJsonContentType,
    express.json({
      limit: handler.maxBodyBytes || MAX_BODY_BYTES,
      strict: false,
      type: () => true,
      verify: (req, res, buffer) => { req.bodyWasEmpty = buffer.length === 0; }
    }),
    requireJsonObject
  ];
}

// ---------------------------------------------------------------------------
// Responses for failures
// ---------------------------------------------------------------------------

// Turns whatever went wrong into the ApiError to answer with, or null if it is
// an unexpected failure (which becomes a generic 500 and is logged).
function toApiError(error) {
  if (error instanceof ApiError) return error;

  // A database constraint rejected something the handler's own checks did not
  // catch. The handlers check first, so reaching this means a bug or a race,
  // not normal use: answer with a clean 4xx instead of a 500.
  const constraint = describeConstraintError(error);
  if (constraint) return new ApiError(constraint.status, constraint.code, constraint.message);

  // Errors raised by express.json() while reading the body.
  switch (error && error.type) {
    case 'entity.too.large':
      return new ApiError(413, 'PAYLOAD_TOO_LARGE', `The request body must be at most ${error.limit} bytes.`);
    case 'entity.parse.failed':
      return String(error.body || '').trim() === ''
        ? new ApiError(400, 'INVALID_JSON', 'The request body is empty.')
        : new ApiError(400, 'INVALID_JSON', 'The request body is not valid JSON.');
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the body as UTF-8 application/json without compression.');
    case 'request.aborted':
    case 'request.size.invalid':
    case 'stream.encoding.set':
      return new ApiError(400, 'BAD_REQUEST', 'The request could not be read.');
    default:
      break;
  }

  // Express could not decode a ":id" part of the URL (for example "%E0%A4%A").
  if (error && error.status === 400 && /^Failed to decode param/.test(error.message)) {
    return new ApiError(400, 'INVALID_ID', 'The URL contains an invalid escape sequence.');
  }
  return null;
}

// Express recognizes an error handler by its four parameters.
function handleError(error, req, res, next) {
  if (res.headersSent) {
    console.error('Error after the response had started:', error);
    return res.destroy();
  }

  // Whatever happened, make sure an unread request body is drained.
  req.resume();

  if (!isApiPath(req)) {
    // Details go to the server console only, never to the client.
    console.error('Unhandled error while handling request:', error);
    return sendTextError(req, res, 500, 'Internal Server Error');
  }

  const apiError = toApiError(error);
  if (apiError) {
    return sendApiError(req, res, apiError.status, apiError.code, apiError.message, {}, apiError.details);
  }

  console.error('Unhandled error while handling request:', error);
  sendApiError(req, res, 500, 'INTERNAL_ERROR', 'Something went wrong on the server.');
}

// ---------------------------------------------------------------------------
// Building the Express app
// ---------------------------------------------------------------------------

// Registers one entry of the route table: a route for each allowed method, then
// a catch-all for the same path that answers 405 with an Allow header.
function registerApiRoute(app, pattern, methods) {
  for (const [method, handler] of Object.entries(methods)) {
    const needsBody = BODY_METHODS.includes(method);
    app[method.toLowerCase()](pattern, ...(needsBody ? bodyMiddleware(handler) : []), async (req, res) => {
      // Express 5 passes a rejected promise to handleError() for us.
      const result = await handler({ req, params: req.params, body: needsBody ? req.body : undefined });
      sendJson(req, res, result.status, result.payload, result.headers);
    });
  }

  app.all(pattern, (req, res) => {
    sendApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'This method is not supported for this endpoint.', {
      Allow: Object.keys(methods).join(', ')
    });
  });
}

// Methods whose body we read. For every other method the body is ignored.
const BODY_METHODS = ['POST', 'PUT'];

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('etag', false); // our responses set their own headers
  // Exact matching, like before: "/api/Accounts" and "/api/accounts/" are NOT "/api/accounts".
  app.set('case sensitive routing', true);
  app.set('strict routing', true);

  app.use((req, res, next) => {
    res.on('finish', () => console.log(`${req.method} ${req.url} -> ${res.statusCode}`));

    // A request target that is not a path (for example "*" or a full URL).
    if (!rawPathOf(req).startsWith('/')) {
      req.resume();
      return sendTextError(req, res, 400, 'Bad Request');
    }
    next();
  });

  for (const [pattern, methods] of Object.entries(apiRoutes)) {
    registerApiRoute(app, pattern, methods);
  }

  // Anything else under /api/ is a JSON 404 (and its body is not read).
  app.use((req, res, next) => {
    if (!isApiPath(req)) return next();
    req.resume();
    sendApiError(req, res, 404, 'NOT_FOUND', 'No such API endpoint.');
  });

  // Everything that is not /api/ is a file from the frontend folder.
  app.use(async (req, res) => {
    req.resume(); // static requests ignore any body
    await handleStatic(req, res, rawPathOf(req));
  });

  app.use(handleError);
  return app;
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

// The Node http server around the Express app. (The tests create their own
// instances of this on random ports.)
function createServer() {
  return http.createServer(createApp());
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
// let in-flight requests finish, close the database pool, then let the process
// end naturally. A timer forces exit if something refuses to finish.
function registerShutdown(server) {
  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received. Shutting down...`);

    const forceTimer = setTimeout(() => {
      console.error('Shutdown timed out. Forcing exit.');
      server.closeAllConnections();
      // Give the pool a moment to close, but never hang on it.
      Promise.race([db.closeDatabase().catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))])
        .then(() => process.exit(1));
    }, 5000);
    forceTimer.unref();

    server.close(async () => {
      try {
        await db.closeDatabase();
      } catch (error) {
        console.error(`Could not close the database cleanly: ${error.message}`);
      }
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
    await db.initDatabase();
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
    db.closeDatabase().catch(() => {});
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

module.exports = { createApp, createServer, start, toApiError };
