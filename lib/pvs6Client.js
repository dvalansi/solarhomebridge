'use strict';

/**
 * Minimal PVS6 local API client.
 * Adapted from homebridge-pvs6 (github.com/dacarson/homebridge-pvs6,
 * src/pvs6Client.ts, MIT License, Copyright (c) 2026 dacarson).
 */

const https = require('https');

const MIN_INTERVAL_MS = 5000;
const TIMEOUT_MS = 10000;

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

class PVS6Client {
  constructor(host, serialNumber, log) {
    this.host = host;
    this.serialNumber = serialNumber;
    this.log = log;
    this.sessionCookie = '';
    this.livedataCacheId = null;
    this.lastRequestTime = 0;
    this.last = { siteLoadPowerW: 0, pvPowerW: 0, netPowerW: 0, pvEnergyKWh: null };
  }

  async authenticate() {
    const password = String(this.serialNumber).slice(-5);
    const credentials = Buffer.from(`ssm_owner:${password}`).toString('base64');
    const { status, headers } = await this.rawRequest('/auth?login', { Authorization: `Basic ${credentials}` });
    if (status === 401) throw new HttpError(401, 'PVS6 rejected the login. Check the serial number.');
    if (status !== 200) throw new HttpError(status, `PVS6 login returned HTTP ${status}`);
    const cookie = headers['set-cookie'];
    if (cookie && cookie.length) this.sessionCookie = cookie[0].split(';')[0].trim();
    this.livedataCacheId = null;
  }

  async poll() {
    const vars = await this.fetchLivedata();
    const read = (key) => {
      const raw = vars[`/sys/livedata/${key}`];
      if (raw === undefined || raw === '') return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };

    const siteLoadKW = read('site_load_p');
    const pvKW = read('pv_p');
    const netKW = read('net_p');
    const pvEnergyKWh = read('pv_en');

    const reading = {
      siteLoadPowerW: siteLoadKW !== null ? Math.round(siteLoadKW * 1000) : this.last.siteLoadPowerW,
      pvPowerW: pvKW !== null ? Math.round(pvKW * 1000) : this.last.pvPowerW,
      netPowerW: netKW !== null ? Math.round(netKW * 1000) : this.last.netPowerW,
      pvEnergyKWh: pvEnergyKWh !== null ? pvEnergyKWh : this.last.pvEnergyKWh,
    };
    this.last = reading;
    return reading;
  }

  async fetchLivedata() {
    if (this.livedataCacheId !== null) {
      try {
        const { status, body } = await this.rawRequest(`/vars?cache=${encodeURIComponent(this.livedataCacheId)}&fmt=obj`);
        if (status === 200) return JSON.parse(body);
      } catch (err) {
        this.log.debug(`livedata cache request failed (${err.message}); refetching`);
      }
      this.livedataCacheId = null;
    }

    const { status, body } = await this.rawRequest('/vars?match=/sys/livedata/&fmt=obj');
    if (status === 401) throw new HttpError(401, 'Session expired');
    if (status >= 500) throw new HttpError(status, `PVS6 HTTP ${status}, device may be busy`);
    if (status !== 200) throw new HttpError(status, `Unexpected HTTP ${status}`);
    if (!body.trim()) throw new Error('Empty response from PVS6');

    let data;
    try {
      data = JSON.parse(body);
    } catch (err) {
      throw new Error(`JSON parse failure: ${body.slice(0, 120)}`);
    }
    for (const key of Object.keys(data)) {
      if (!key.startsWith('/')) {
        this.livedataCacheId = String(data[key]);
        break;
      }
    }
    return data;
  }

  rawRequest(path, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const elapsed = Date.now() - this.lastRequestTime;
      const delay = this.lastRequestTime > 0 && elapsed < MIN_INTERVAL_MS ? MIN_INTERVAL_MS - elapsed : 0;

      const doRequest = () => {
        this.lastRequestTime = Date.now();
        const headers = { ...extraHeaders };
        if (!headers.Authorization && this.sessionCookie) headers.Cookie = this.sessionCookie;

        const [hostname, port] = String(this.host).split(':');
        const req = https.request({
          hostname,
          port: port ? Number(port) : 443,
          path,
          method: 'GET',
          headers,
          rejectUnauthorized: false, // PVS6 uses a self-signed certificate
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`timeout after ${TIMEOUT_MS / 1000}s`)));
        req.on('error', reject);
        req.end();
      };

      if (delay > 0) setTimeout(doRequest, delay); else doRequest();
    });
  }
}

module.exports = { PVS6Client, HttpError };
