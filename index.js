'use strict';

const { PLATFORM_NAME } = require('./lib/settings');
const { TilesPlatform } = require('./lib/platform');

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, TilesPlatform);
};
