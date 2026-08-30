'use strict';

const { sendJson } = require('../lib/handlers');
const { isEnabled, checkPassword, cookieHeader } = require('../lib/auth');
const { wrap } = require('./_wrap');

// Menukar kata sandi dengan cookie sesi. Cookie dipakai (bukan header) supaya
// <img src> dan unduhan ZIP lewat <form> ikut membawanya.
module.exports = wrap('POST', async (req, res) => {
  if (!isEnabled()) return sendJson(res, 200, { ok: true, locked: false });

  const body =
    typeof req.body === 'object' && req.body !== null
      ? req.body
      : JSON.parse(String(req.body || '{}'));

  if (!checkPassword(body.password)) {
    return sendJson(res, 401, { error: 'Kata sandi salah.', code: 'auth' });
  }

  res.setHeader('Set-Cookie', cookieHeader(true));
  sendJson(res, 200, { ok: true });
});
