'use strict';

// Small helpers shared by every API module.

// An error that carries the HTTP status and a machine-readable code.
// Throw it from a handler; server.js turns it into the standard JSON error:
//   { "ok": false, "error": { "code", "message", "details"? } }
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details; // optional: [{ field, message }, ...]
  }
}

// What a handler returns for success. server.js sends it as
//   { "ok": true, "data": <data> }
function ok(data, status = 200, headers = {}) {
  return { status, payload: { ok: true, data }, headers };
}

// Money is stored as whole minor units (paise). These two functions are the
// only place that converts between that and the decimal numbers in the API.
function toMinor(amount) {
  return Math.round(amount * 100);
}

function fromMinor(minor) {
  return minor / 100;
}

module.exports = { ApiError, ok, toMinor, fromMinor };
