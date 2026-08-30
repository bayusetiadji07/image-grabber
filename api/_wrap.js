'use strict';

// Pembungkus bersama untuk seluruh serverless function: membatasi metode,
// menerjemahkan exception jadi JSON berbahasa Indonesia, dan memastikan
// respons yang sudah terlanjur mengalir tidak ditimpa header baru.

const { describeError, sendJson } = require('../lib/handlers');

function wrap(method, handler) {
  return async function vercelHandler(req, res) {
    if (method && req.method !== method) {
      return sendJson(res, 405, { error: `Metode ${req.method} tidak didukung di sini.` });
    }
    try {
      await handler(req, res);
    } catch (err) {
      const { status, message, code } = describeError(err);
      console.error(`[error] ${req.method} ${req.url}:`, message);
      if (res.headersSent) {
        res.destroy?.();
        return;
      }
      sendJson(res, status, { error: message, code });
    }
  };
}

// URL lengkap permintaan — di Vercel req.url hanya berisi path + query.
function fullUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return new URL(req.url, `${proto}://${host}`);
}

module.exports = { wrap, fullUrl };
