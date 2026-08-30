'use strict';

const { handleZip } = require('../lib/handlers');
const { wrap } = require('./_wrap');

module.exports = wrap('POST', handleZip);
