'use strict';

module.exports = {
  PLUGIN_NAME: 'homebridge-pvs6-tiles',
  PLATFORM_NAME: 'PVS6Tiles',
  DEFAULT_POLL_S: 30,
  MIN_POLL_S: 15,
  // HomeKit's CurrentAmbientLightLevel range
  LUX_MIN: 0.0001,
  LUX_MAX: 100000,
};
