'use strict';

// Small client for the Expense Manager backend (see docs/API.md).
//
// Every page loads this file before script.js. It is the ONLY place that talks
// to /api/..., so request and error handling is written once.
//
// - Paths are relative to the page's own address ("/api/..."), so the app
//   works at whatever host and port the server runs on.
// - A call resolves with the `data` of a successful response.
// - A call rejects with an ApiError. Its `message` is always safe to show to
//   the user: it never contains stack traces, SQL or file paths.
//
// In a browser this file creates the globals `Api` and `ApiError`. In Node (the
// automated tests) it exports { createClient, ApiError } instead.

(function (root) {
  const REQUEST_TIMEOUT_MS = 15000;
  const IMPORT_TIMEOUT_MS = 120000; // an import can carry thousands of records

  // These 5xx errors come with a fixed, safe sentence that tells the user what
  // state the data is in ("nothing was saved"), so it is shown as it is.
  const SAFE_SERVER_MESSAGES = ['IMPORT_FAILED', 'PREVIEW_FAILED'];

  // Names shown to the user instead of API field names.
  const FIELD_LABELS = {
    type: 'Type',
    description: 'Description',
    categoryId: 'Category',
    accountId: 'Account',
    amount: 'Amount',
    note: 'Note',
    date: 'Date',
    from: 'From',
    to: 'To',
    search: 'Search',
    category: 'Category',
    name: 'Name',
    balance: 'Balance'
  };

  class ApiError extends Error {
    // kind: 'network' (no usable response), 'server' (HTTP 5xx) or 'request' (HTTP 4xx).
    constructor({ kind, status = 0, code = '', message, details = [] }) {
      super(message);
      this.name = 'ApiError';
      this.kind = kind;
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  function networkError(message) {
    return new ApiError({ kind: 'network', message });
  }

  // Turns a failed HTTP response into an ApiError with a user-safe message.
  function errorFromResponse(status, payload) {
    const error = payload && payload.ok === false && payload.error ? payload.error : null;

    if (status >= 500 && error && SAFE_SERVER_MESSAGES.includes(error.code)) {
      return new ApiError({ kind: 'server', status, code: error.code, message: error.message });
    }

    if (status >= 500) {
      // Never pass server text through for a 5xx; it is already generic, but the
      // UI should not depend on that.
      return new ApiError({
        kind: 'server',
        status,
        code: error ? error.code : '',
        message: status === 503
          ? 'The database is not available right now. Please try again in a moment.'
          : 'The server had a problem. Please try again.'
      });
    }

    if (!error) {
      return new ApiError({
        kind: 'request',
        status,
        message: `Unexpected response from the server (HTTP ${status}).`
      });
    }

    const details = Array.isArray(error.details) ? error.details : [];
    const message = details.length > 0
      ? details.map(item => `${FIELD_LABELS[item.field] || item.field}: ${item.message}`).join(' ')
      : error.message;

    return new ApiError({ kind: 'request', status, code: error.code, message, details });
  }

  // `fetchImpl` is injectable so the tests can use Node's fetch with a base URL.
  function createClient(fetchImpl, baseUrl = '') {
    async function request(method, path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
      if (typeof location !== 'undefined' && location.protocol === 'file:') {
        throw networkError('Open the app through the server (run "npm start", then visit http://127.0.0.1:3000).');
      }

      const options = { method, headers: { Accept: 'application/json' } };
      if (body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;

      try {
        response = await fetchImpl(baseUrl + path, { ...options, signal: controller.signal });
      } catch (error) {
        throw networkError('Cannot reach the server. Make sure it is running (npm start) and try again.');
      } finally {
        clearTimeout(timer);
      }

      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        // Not JSON (for example an error page from something in front of the server).
      }

      if (!response.ok || !payload || payload.ok !== true) {
        throw errorFromResponse(response.status, payload);
      }
      return payload.data;
    }

    // "/api/transactions" + "?type=income&search=tea". Empty values are left out.
    const withQuery = (path, params) => {
      const query = new URLSearchParams();
      Object.entries(params || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
      });
      const text = query.toString();
      return text ? `${path}?${text}` : path;
    };

    const item = (collection, id) => `/api/${collection}/${encodeURIComponent(id)}`;

    return {
      health: () => request('GET', '/api/health'),

      // Import of the previous version's data (see docs/API.md). Preview changes
      // nothing. The real import is only sent with an explicit confirm: true.
      previewImport: backup => request('POST', '/api/import/preview', backup, IMPORT_TIMEOUT_MS),
      importLegacy: backup => request('POST', '/api/import', { ...backup, confirm: true }, IMPORT_TIMEOUT_MS),
      exportDatabase: () => request('GET', '/api/export', undefined, IMPORT_TIMEOUT_MS),

      listAccounts: () => request('GET', '/api/accounts'),
      createAccount: account => request('POST', '/api/accounts', account),
      deleteAccount: id => request('DELETE', item('accounts', id)),

      listCategories: () => request('GET', '/api/categories'),
      createCategory: category => request('POST', '/api/categories', category),
      deleteCategory: id => request('DELETE', item('categories', id)),

      // Optional filters (type, categoryId, category, accountId, from, to, search,
      // limit, offset); the server does the filtering. See docs/API.md.
      listTransactions: filters => request('GET', withQuery('/api/transactions', filters)),
      // Totals, per-category totals and per-month totals for the same filters.
      getSummary: filters => request('GET', withQuery('/api/summary', filters)),
      createTransaction: transaction => request('POST', '/api/transactions', transaction),
      deleteTransaction: id => request('DELETE', item('transactions', id))
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createClient, ApiError };
  } else {
    root.ApiError = ApiError;
    root.Api = createClient((url, options) => fetch(url, options));
  }
})(typeof window !== 'undefined' ? window : globalThis);
