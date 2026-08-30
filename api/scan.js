'use strict';

const { handleScan } = require('../lib/handlers');
const { wrap } = require('./_wrap');

module.exports = wrap('POST', handleScan);
