'use strict';

// Request-body validation shared by accounts, categories and transactions.
//
// Every function takes the input value, the field name and an `errors` array.
// Instead of stopping at the first problem, they push { field, message } and
// return undefined, so the client sees ALL problems in one response. Call
// throwIfInvalid(errors) at the end.

const { ApiError } = require('./common');

const MAX_AMOUNT = 1000000000; // same limit as the frontend forms
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function has(body, field) {
  return Object.hasOwn(body, field) && body[field] !== undefined;
}

// Rejects fields we do not know, so a typo (or a field that belongs to a later
// stage) is reported instead of being silently ignored.
function rejectUnknownFields(body, allowed, errors) {
  for (const field of Object.keys(body)) {
    if (!allowed.includes(field)) {
      errors.push({ field, message: 'Unknown field.' });
    }
  }
}

// Required (or optional) text. Surrounding spaces are trimmed, as the frontend
// forms do, and the TRIMMED length is checked.
function text(body, field, errors, { max, required = true, defaultValue } = {}) {
  if (!has(body, field)) {
    if (required) errors.push({ field, message: 'This field is required.' });
    return defaultValue;
  }
  if (typeof body[field] !== 'string') {
    errors.push({ field, message: 'Must be a string.' });
    return undefined;
  }
  const value = body[field].trim();
  if (required && value.length === 0) {
    errors.push({ field, message: 'Must not be empty.' });
    return undefined;
  }
  if (value.length > max) {
    errors.push({ field, message: `Must be at most ${max} characters.` });
    return undefined;
  }
  return value;
}

function oneOf(body, field, errors, allowed) {
  if (!has(body, field)) {
    errors.push({ field, message: 'This field is required.' });
    return undefined;
  }
  if (typeof body[field] !== 'string' || !allowed.includes(body[field])) {
    errors.push({ field, message: `Must be one of: ${allowed.join(', ')}.` });
    return undefined;
  }
  return body[field];
}

// A money amount as a JSON number with at most 2 decimal places.
// Returns the value as a number (not yet converted to minor units).
function money(body, field, errors, { allowZero }) {
  if (!has(body, field)) {
    errors.push({ field, message: 'This field is required.' });
    return undefined;
  }
  const value = body[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push({ field, message: 'Must be a number.' });
    return undefined;
  }
  if (allowZero ? value < 0 : value <= 0) {
    errors.push({ field, message: allowZero ? 'Must be zero or more.' : 'Must be greater than zero.' });
    return undefined;
  }
  if (value > MAX_AMOUNT) {
    errors.push({ field, message: `Must be at most ${MAX_AMOUNT}.` });
    return undefined;
  }
  // The frontend rounds to 2 decimals silently. The API refuses instead of
  // changing a financial value behind the client's back.
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    errors.push({ field, message: 'Must have at most 2 decimal places.' });
    return undefined;
  }
  return value;
}

// Local calendar date as YYYY-MM-DD, the same way the frontend's todayISO() does.
function todayISO() {
  const now = new Date();
  return (
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-` +
    `${String(now.getDate()).padStart(2, '0')}`
  );
}

// A real calendar date in YYYY-MM-DD form (2025-02-30 is rejected) that is not
// in the future (the frontend rule for transactions).
function isoDate(body, field, errors) {
  if (!has(body, field)) {
    errors.push({ field, message: 'This field is required.' });
    return undefined;
  }
  const value = body[field];
  const match = typeof value === 'string' ? DATE_PATTERN.exec(value) : null;
  if (!match) {
    errors.push({ field, message: 'Must be a date in YYYY-MM-DD format.' });
    return undefined;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  const real =
    check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
  if (!real || year < 1900) {
    errors.push({ field, message: 'Must be a real calendar date.' });
    return undefined;
  }
  if (value > todayISO()) {
    errors.push({ field, message: 'The date cannot be in the future.' });
    return undefined;
  }
  return value;
}

// Optional client-supplied id (used later to import existing records with the
// ids they already have). Returns undefined when absent.
function optionalId(body, field, errors) {
  if (!has(body, field)) return undefined;
  if (typeof body[field] !== 'string' || !ID_PATTERN.test(body[field])) {
    errors.push({ field, message: 'Must be 1-64 characters: letters, digits, "-" or "_".' });
    return undefined;
  }
  return body[field];
}

function requiredId(body, field, errors) {
  if (!has(body, field)) {
    errors.push({ field, message: 'This field is required.' });
    return undefined;
  }
  return optionalId(body, field, errors);
}

// Optional creation time in milliseconds since 1970 (the frontend's createdAt).
function optionalTimestamp(body, field, errors) {
  if (!has(body, field)) return undefined;
  const value = body[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    errors.push({ field, message: 'Must be a non-negative whole number (milliseconds).' });
    return undefined;
  }
  return value;
}

function requiredInteger(body, field, errors) {
  if (!has(body, field)) {
    errors.push({ field, message: 'This field is required.' });
    return undefined;
  }
  if (!Number.isSafeInteger(body[field]) || body[field] < 1) {
    errors.push({ field, message: 'Must be a positive whole number.' });
    return undefined;
  }
  return body[field];
}

function throwIfInvalid(errors) {
  if (errors.length > 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request contains invalid data.', errors);
  }
}

// Validates an id taken from the URL (e.g. /api/accounts/<id>).
function textIdParam(value) {
  if (!ID_PATTERN.test(value)) {
    throw new ApiError(400, 'INVALID_ID', 'The id in the URL is not valid.');
  }
  return value;
}

function numericIdParam(value) {
  if (!/^[1-9]\d{0,14}$/.test(value)) {
    throw new ApiError(400, 'INVALID_ID', 'The id in the URL must be a positive whole number.');
  }
  return Number(value);
}

function pluralize(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

module.exports = {
  rejectUnknownFields,
  text,
  oneOf,
  money,
  isoDate,
  optionalId,
  requiredId,
  optionalTimestamp,
  requiredInteger,
  throwIfInvalid,
  textIdParam,
  numericIdParam,
  pluralize
};
