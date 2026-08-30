'use strict';

const { sendJson } = require('../lib/handlers');
const { isEnabled, isAuthorized } = require('../lib/auth');
const { wrap } = require('./_wrap');

// Dipakai UI saat halaman dibuka: perlu login atau tidak.
module.exports = wrap('GET', async (req, res) => {
  sendJson(res, 200, { locked: isEnabled(), authorized: isAuthorized(req) });
});
