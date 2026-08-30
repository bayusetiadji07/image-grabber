'use strict';

const { handleMeta } = require('../lib/handlers');
const { wrap } = require('./_wrap');

module.exports = wrap('POST', handleMeta);
