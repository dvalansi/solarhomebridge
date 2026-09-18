'use strict';

const fs = require('fs');
const path = require('path');
const { PLUGIN_NAME, PLATFORM_NAME, DEFAULT_POLL_S, MIN_POLL_S, LUX_MIN, LUX_MAX } = require('./settings');
const { PVS6Client, HttpError } = require('./pvs6Client');

const ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;
const BACKOFF_MS = 60 * 1000;
const AUTH_RETRY_MS = 30 * 1000;
const STATE_FILE = '.pvs6-tiles-state.json';

class TilesPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.cached = [];
    this.tiles = [];

    let pollS = Number(this.config.pollInterval) || DEFAULT_POLL_S;
    if (pollS < MIN_POLL_S) {
      this.log.warn(`pollInterval ${pollS}s is below the ${MIN_POLL_S}s minimum; using ${MIN_POLL_S}s.`);
      pollS = MIN_POLL_S;
    }
    this.pollIntervalMs = pollS * 1000;

    this.pollInFlight = false;
    this.backoffUntil = 0;
    this.lastErrorLog = 0;
    this.consecutiveErrors = 0;
    this.solarToday = this.loadState();

    this.api.on('didFinishLaunching', () => this.start());
    this.api.on('shutdown', () => { if (this.timer) clearInterval(this.timer); });
  }

  configureAccessory(accessory) {
    this.cached.push(accessory);
  }

  // --- PVS6 location -------------------------------------------------------

  resolvePvs6() {
    if (this.config.host && this.config.serialNumber) {
      return { host: this.config.host, serialNumber: this.config.serialNumber, source: 'plugin settings' };
    }

    // Reuse the settings from homebridge-pvs6 so no extra setup is needed.
    try {
      const hbConfig = JSON.parse(fs.readFileSync(this.api.user.configPath(), 'utf8'));
      const pvs6 = (hbConfig.platforms || []).find((p) => p.platform === 'PVS6');
      if (pvs6 && pvs6.host && pvs6.serialNumber) {
        return { host: pvs6.host, serialNumber: pvs6.serialNumber, source: 'homebridge-pvs6 settings' };
      }
    } catch (err) {
      this.log.debug(`Could not read Homebridge config.json: ${err.message}`);
    }

    try {
      const cache = JSON.parse(fs.readFileSync(path.join(this.api.user.storagePath(), '.pvs6-discovery-cache.json'), 'utf8'));
      if (cache.host && cache.serialNumber) {
        return { host: cache.host, serialNumber: cache.serialNumber, source: 'homebridge-pvs6 discovery cache' };
      }
    } catch (err) {
      this.log.debug(`No homebridge-pvs6 discovery cache: ${err.message}`);
    }

    return null;
  }

  // --- Tiles ---------------------------------------------------------------

  tileDefinitions() {
    const c = this.config;
    const defs = [
      { key: 'house', name: c.houseName || 'House Usage', enabled: true, value: (r) => r.siteLoadPowerW },
      { key: 'solar', name: c.solarName || 'Solar Now', enabled: c.solarTile === true, value: (r) => r.pvPowerW },
      { key: 'grid-buy', name: c.gridBuyName || 'Grid Buying', enabled: c.gridTiles === true, value: (r) => Math.max(0, r.netPowerW) },
      { key: 'grid-sell', name: c.gridSellName || 'Grid Selling', enabled: c.gridTiles === true, value: (r) => Math.max(0, -r.netPowerW) },
      { key: 'solar-today', name: c.solarTodayName || 'Solar Today Wh', enabled: c.solarTodayTile === true, value: (r) => this.solarTodayWh(r) },
    ];
    return defs;
  }

  setupTiles() {
    const defs = this.tileDefinitions();
    const wanted = new Set();

    for (const def of defs) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${def.key}`);
      if (!def.enabled) continue;
      wanted.add(uuid);

      let accessory = this.cached.find((a) => a.UUID === uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(def.name, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added tile: ${def.name}`);
      }

      const info = accessory.getService(this.Service.AccessoryInformation);
      info
        .setCharacteristic(this.Characteristic.Manufacturer, 'SunStrong')
        .setCharacteristic(this.Characteristic.Model, 'PVS6 Tile')
        .setCharacteristic(this.Characteristic.SerialNumber, `pvs6-tile-${def.key}`);

      const sensor = accessory.getService(this.Service.LightSensor) || accessory.addService(this.Service.LightSensor, def.name);
      sensor.setCharacteristic(this.Characteristic.Name, def.name);
      const tile = { def, accessory, sensor, lux: LUX_MIN };
      sensor.getCharacteristic(this.Characteristic.CurrentAmbientLightLevel)
        .setProps({ minValue: LUX_MIN, maxValue: LUX_MAX })
        .onGet(() => tile.lux);
      this.tiles.push(tile);
    }

    const stale = this.cached.filter((a) => !wanted.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info(`Removed ${stale.length} disabled tile(s).`);
    }
  }

  // --- Solar today (Wh), from the lifetime pv_en counter --------------------

  loadState() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.api.user.storagePath(), STATE_FILE), 'utf8'));
    } catch {
      return { date: null, baselineKWh: null };
    }
  }

  saveState() {
    try {
      fs.writeFileSync(path.join(this.api.user.storagePath(), STATE_FILE), JSON.stringify(this.solarToday), 'utf8');
    } catch (err) {
      this.log.debug(`Could not save state: ${err.message}`);
    }
  }

  solarTodayWh(reading) {
    if (reading.pvEnergyKWh === null) return 0;
    const now = new Date();
    const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (this.solarToday.date !== today || this.solarToday.baselineKWh === null || reading.pvEnergyKWh < this.solarToday.baselineKWh) {
      this.solarToday = { date: today, baselineKWh: reading.pvEnergyKWh };
      this.saveState();
    }
    return Math.max(0, Math.round((reading.pvEnergyKWh - this.solarToday.baselineKWh) * 1000));
  }

  // --- Polling -------------------------------------------------------------

  start() {
    const location = this.resolvePvs6();
    if (!location) {
      this.log.error('Could not find the PVS6 host and serial number. Enter them in this plugin\'s settings, or set Host and Serial Number in homebridge-pvs6.');
      return;
    }
    this.log.info(`Using PVS6 at ${location.host} (from ${location.source}).`);
    this.client = new PVS6Client(location.host, location.serialNumber, this.log);
    this.setupTiles();
    this.authenticateThenPoll();
  }

  authenticateThenPoll() {
    this.client.authenticate()
      .then(() => {
        this.log.info(`Connected to PVS6. Updating tiles every ${this.pollIntervalMs / 1000}s.`);
        this.poll();
        if (!this.timer) this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
      })
      .catch((err) => {
        this.log.error(`PVS6 login failed: ${err.message}. Retrying in ${AUTH_RETRY_MS / 1000}s.`);
        setTimeout(() => this.authenticateThenPoll(), AUTH_RETRY_MS);
      });
  }

  async poll() {
    if (this.pollInFlight || Date.now() < this.backoffUntil) return;
    this.pollInFlight = true;
    try {
      const reading = await this.client.poll();
      if (this.consecutiveErrors > 0) this.log.info('PVS6 reachable again.');
      this.consecutiveErrors = 0;

      for (const tile of this.tiles) {
        const raw = Number(tile.def.value(reading)) || 0;
        tile.lux = Math.min(LUX_MAX, Math.max(LUX_MIN, raw));
        tile.sensor.updateCharacteristic(this.Characteristic.CurrentAmbientLightLevel, tile.lux);
      }
      this.log.debug(this.tiles.map((t) => `${t.def.name}=${t.lux === LUX_MIN ? 0 : t.lux}`).join('  '));
    } catch (err) {
      await this.handleError(err);
    } finally {
      this.pollInFlight = false;
    }
  }

  async handleError(err) {
    this.consecutiveErrors++;
    const now = Date.now();
    const logIt = now - this.lastErrorLog > ERROR_LOG_INTERVAL_MS;

    if (err instanceof HttpError && err.statusCode === 401) {
      this.log.debug('PVS6 session expired; logging in again.');
      try {
        await this.client.authenticate();
        this.consecutiveErrors = 0;
      } catch (authErr) {
        this.log.warn(`PVS6 re-login failed: ${authErr.message}`);
        this.backoffUntil = now + BACKOFF_MS;
      }
      return;
    }

    if (logIt) {
      this.log.warn(`PVS6 poll error: ${err.message}`);
      this.lastErrorLog = now;
    } else {
      this.log.debug(`PVS6 poll error: ${err.message}`);
    }

    if ((err instanceof HttpError && err.statusCode >= 500) || this.consecutiveErrors >= 3) {
      this.backoffUntil = now + BACKOFF_MS;
      this.consecutiveErrors = 0;
      // Force a fresh login after repeated failures.
      this.client.authenticate().catch(() => {});
    }
  }
}

module.exports = { TilesPlatform };
