'use strict';

// Recognizing PostgreSQL constraint errors.
//
// PostgreSQL reports every error with a five-character SQLSTATE code in
// `error.code`. The codes are stable across versions and languages, unlike the
// message text, so we match on them. This module has no dependencies and does
// not touch the database, so it is easy to test on its own.

const SQLSTATE = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502'
};

const codeOf = error => (error && typeof error.code === 'string' ? error.code : undefined);

const isUniqueViolation = error => codeOf(error) === SQLSTATE.UNIQUE_VIOLATION;
const isForeignKeyViolation = error => codeOf(error) === SQLSTATE.FOREIGN_KEY_VIOLATION;
const isCheckViolation = error => codeOf(error) === SQLSTATE.CHECK_VIOLATION;
const isNotNullViolation = error => codeOf(error) === SQLSTATE.NOT_NULL_VIOLATION;

// "Integrity constraint violation" is the whole SQLSTATE class 23.
const isConstraintViolation = error => (codeOf(error) || '').startsWith('23');

// What the API should answer when a constraint rejects a write that the
// handler's own checks did not catch (a bug or a race, not normal use).
// The status/code/message triples are the ones the SQLite version used, so the
// API's behavior does not change. Returns null for any other kind of error.
// This module does not import ApiError; the caller turns the result into one.
function describeConstraintError(error) {
  if (isUniqueViolation(error)) {
    return { status: 409, code: 'CONFLICT', message: 'That value already exists.' };
  }
  if (isForeignKeyViolation(error)) {
    return { status: 409, code: 'CONSTRAINT_VIOLATION', message: 'The record is linked to other records.' };
  }
  if (isCheckViolation(error) || isNotNullViolation(error)) {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'The request contains invalid data.' };
  }
  return null;
}

module.exports = {
  SQLSTATE,
  isUniqueViolation,
  isForeignKeyViolation,
  isCheckViolation,
  isNotNullViolation,
  isConstraintViolation,
  describeConstraintError
};
