'use strict';

const { handleImage } = require('../lib/handlers');
const { wrap, fullUrl } = require('./_wrap');

module.exports = wrap('GET', (req, res) => handleImage(req, res, fullUrl(req)));
