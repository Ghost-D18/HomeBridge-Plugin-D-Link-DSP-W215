// homebridge-dlink-wifi-smart-plug-dsp-w215 (optimized + child-bridge aware restart handling)
// All comments and code are in English per your request. Logging helpers and debug flag included.
// New behavior:
// - if a critical, unrecoverable error occurs and the accessory is running as a child-bridge,
//   the plugin will schedule a process exit that should restart the bridge only (exit code 2).
// - if not a child-bridge and forceRestartOnFailure === true, the plugin will schedule a process exit
//   that restarts the whole Homebridge process (exit code 1).
// - autodetection of child-bridge with explicit override via config.childBridge.

const WebSocketClient = require('dlink_websocketclient');
let Service, Characteristic, HOMEBRIDGE_API;

module.exports = (homebridge) => {
  // capture homebridge API for possible autodetection of child bridge
  HOMEBRIDGE_API = homebridge;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory("homebridge-dlink-wifi-smart-plug-dsp-w215", "DLinkSmartPlug", DLinkSmartPlug);
};

class DLinkSmartPlug {
  constructor(log, config = {}) {
    // Basic identity & options
    this.log = log;
    this.name = config.name || "D-Link Smart Plug";
    this.ip = config.ip;
    this.pin = config.pin; // token or "TELNET"
    this.useTelnetForToken = !!config.useTelnetForToken;

    this.options = {
      ip: this.ip,
      pin: this.pin,
      useTelnetForToken: this.useTelnetForToken
    };

    this.maxRetries = Number.isInteger(config.maxRetries) ? config.maxRetries : 5;
    this.initialRetryDelayMs = Number.isInteger(config.initialRetryDelayMs) ? config.initialRetryDelayMs : 1000;
    this.tokenUpdateIntervalMs = Number.isInteger(config.tokenUpdateIntervalMs) ? config.tokenUpdateIntervalMs : 300000;
    this.forceRestartOnFailure = !!config.forceRestartOnFailure;

    // Debug flag: verbose logging if true
    this.debug = !!config.debug;

    // Child-bridge handling:
    // 1) explicit override via config.childBridge (true/false)
    // 2) try to autodetect via HOMEBRIDGE_API if available
    // 3) fallback false
    this.runningAsChildBridge = false;
    if (typeof config.childBridge === 'boolean') {
      this.runningAsChildBridge = config.childBridge;
    } else {
      try {
        if (HOMEBRIDGE_API && typeof HOMEBRIDGE_API.isChildBridge === 'boolean') {
          this.runningAsChildBridge = HOMEBRIDGE_API.isChildBridge;
        } else if (HOMEBRIDGE_API && HOMEBRIDGE_API.server && typeof HOMEBRIDGE_API.server.name === 'string') {
          // heuristic: some child bridge server names contain 'child' or 'bridge'
          const sn = HOMEBRIDGE_API.server.name.toLowerCase();
          if (sn.includes('child') || sn.includes('bridge')) this.runningAsChildBridge = true;
        }
        // environment heuristic (rare): some setups export a child flag
        if (!this.runningAsChildBridge && process.env.HOMEBRIDGE_CHILD === '1') this.runningAsChildBridge = true;
      } catch (e) {
        // ignore detection errors and default to false
        this.runningAsChildBridge = false;
      }
    }

    // Internal state
    this.client = new WebSocketClient(this.options);
    this.shutdownRequested = false;
    this.loginPromise = null;
    this.tokenUpdateInProgress = false;
    this.tokenUpdateInterval = null;
    this._opQueue = Promise.resolve(); // serialized operation queue

    // Start periodic token refresh only if telnet-based token retrieval is enabled
    if (this.useTelnetForToken) {
      this._startTokenUpdateInterval();
    }

    this._logInfo(`Initializing '${this.name}' ip=${this.ip} childBridge=${this.runningAsChildBridge} telnetToken=${this.useTelnetForToken}`);
  }

  // ---------- Logging helpers ----------
  _logDebug(...args) { if (this.debug) this._nativeLog('debug', ...args); }
  _logInfo(...args) { if (this.debug) this._nativeLog('info', ...args); }
  _logWarn(...args) { this._nativeLog('warn', ...args); }
  _logError(...args) { this._nativeLog('error', ...args); }

  _nativeLog(level, ...args) {
    try {
      const message = args.map(a => (typeof a === 'string' ? a : (a && a.message ? a.message : JSON.stringify(a)))).join(' ');
      if (level === 'debug' && typeof this.log.debug === 'function') return this.log.debug(message);
      if (level === 'info' && typeof this.log.info === 'function') return this.log.info(message);
      if (level === 'warn' && typeof this.log.warn === 'function') return this.log.warn(message);
      if (level === 'error' && typeof this.log.error === 'function') return this.log.error(message);
      // fallback
      this.log(`${level.toUpperCase()}: ${message}`);
    } catch (e) {
      try { this.log('Logging error:', e && e.message ? e.message : e); } catch (_) { /* noop */ }
    }
  }

  _isTokenError(err) {
    if (!err) return false;
    const code = err.code;
    const msg = (err && (err.message || err.toString())) || '';
    const lower = String(msg).toLowerCase();
    return code === 424 || lower.includes("invalid device token") || lower.includes("invalid token") || lower.includes("token expired");
  }

  // ---------- Critical failure handler ----------
  // This centralizes the restart behavior:
  // - if running as child bridge -> exit with code 2 (often triggers bridge restart)
  // - else if not child bridge and forceRestartOnFailure -> exit with code 1 (to restart Homebridge)
  // - else: log and do not exit
  _handleCriticalFailure(reason) {
    const msg = reason && (reason.message || reason.toString()) ? (reason.message || reason.toString()) : String(reason);
    this._logError("CRITICAL: unrecoverable error:", msg);

    if (this.runningAsChildBridge) {
      // try to restart only the bridge (exit code 2 chosen as conventional distinct code)
      this._logError("Accessory configured as child-bridge -> scheduling child-bridge restart (exit 2) in 1s");
      setTimeout(() => {
        try { process.exit(2); } catch (e) { /* best effort */ }
      }, 1000);
      return;
    }

    if (this.forceRestartOnFailure) {
      // restart entire Homebridge process
      this._logError("forceRestartOnFailure=true -> scheduling full Homebridge restart (exit 1) in 1s");
      setTimeout(() => {
        try { process.exit(1); } catch (e) { /* best effort */ }
      }, 1000);
      return;
    }

    // If not child-bridge and not forcing restart, just log and avoid killing the process
    this._logWarn("Not configured to restart (neither childBridge nor forceRestartOnFailure). Plugin will remain loaded but in error state.");
  }

  // ---------- Operation queue ----------
  _enqueueOperation(fn) {
    this._opQueue = this._opQueue.then(() => {
      if (this.shutdownRequested) return Promise.reject(new Error("Accessory shutting down"));
      return fn();
    }).catch(err => {
      return Promise.reject(err);
    });
    return this._opQueue;
  }

  // ---------- Token interval management ----------
  _startTokenUpdateInterval() {
    if (this.tokenUpdateInterval) return;
    this.tokenUpdateInterval = setInterval(async () => {
      if (this.shutdownRequested) return;
      if (this.tokenUpdateInProgress) {
        this._logDebug("Periodic token update skipped: in progress");
        return;
      }
      this.tokenUpdateInProgress = true;
      try {
        this._logDebug("Periodic token update: fetching token via telnet...");
        const newToken = await this.client.getTokenFromTelnet();
        if (newToken) {
          if (typeof this.client.setPin === 'function') {
            this.client.setPin(newToken);
          } else if (typeof this.client.updatePin === 'function') {
            this.client.updatePin(newToken);
          } else {
            this._logWarn("Client does not support setPin/updatePin");
          }
          this._logDebug("Periodic token updated (not printed)");
        } else {
          this._logWarn("Periodic token update: telnet returned no token");
        }
      } catch (err) {
        this._logWarn("Periodic token update error:", err && err.message ? err.message : err);
      } finally {
        this.tokenUpdateInProgress = false;
      }
    }, this.tokenUpdateIntervalMs);
  }

  _clearTokenUpdateInterval() {
    if (this.tokenUpdateInterval) {
      clearInterval(this.tokenUpdateInterval);
      this.tokenUpdateInterval = null;
    }
  }

  // ---------- Login handling ----------
  async ensureConnected() {
    if (this.shutdownRequested) throw new Error("Accessory shutting down");

    if (this.loginPromise) {
      this._logDebug("Awaiting ongoing login attempt");
      return this.loginPromise;
    }

    this.loginPromise = (async () => {
      let attempt = 0;
      let delay = this.initialRetryDelayMs;

      while (attempt < this.maxRetries && !this.shutdownRequested) {
        attempt++;
        try {
          this._logDebug(`Attempting login (attempt ${attempt})`);
          await this.client.login();
          this._logDebug(`Login successful (attempt ${attempt})`);
          this.loginPromise = null;
          return;
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          this._logWarn(`Login failed (attempt ${attempt}): ${msg}`);

          if (this._isTokenError(err) && this.useTelnetForToken) {
            // try to recover token via telnet before next attempt
            try {
              this._logDebug("Token error detected during login -> fetching token via telnet");
              const newToken = await this.client.getTokenFromTelnet();
              if (newToken) {
                if (typeof this.client.setPin === 'function') {
                  this.client.setPin(newToken);
                } else if (typeof this.client.updatePin === 'function') {
                  this.client.updatePin(newToken);
                }
                this._logDebug("Token updated locally, retrying login immediately");
                continue; // retry immediately within loop
              } else {
                this._logWarn("Telnet did not return token during login recovery");
              }
            } catch (telnetErr) {
              this._logWarn("Error fetching telnet token during login recovery:", telnetErr && telnetErr.message ? telnetErr.message : telnetErr);
            }
          }

          if (attempt < this.maxRetries) {
            this._logDebug(`Waiting ${delay}ms before next login attempt`);
            await new Promise(res => setTimeout(res, delay));
            delay = Math.min(delay * 2, 30000);
            continue;
          } else {
            const finalError = new Error(`Login failed after ${attempt} attempts: ${msg}`);
            this.loginPromise = null;
            this._logError(finalError.message);
            // Consider this a critical failure condition — handle according to configuration
            this._handleCriticalFailure(finalError);
            throw finalError;
          }
        }
      }

      this.loginPromise = null;
      throw new Error("Login aborted: shutting down or retries exhausted");
    })();

    return this.loginPromise;
  }

  async refreshTokenAndReconnect() {
    if (!this.useTelnetForToken) throw new Error("refreshTokenAndReconnect called but useTelnetForToken is false");

    while (this.tokenUpdateInProgress) {
      this._logDebug("Waiting for in-progress token update...");
      await new Promise(r => setTimeout(r, 200));
    }

    this.tokenUpdateInProgress = true;
    try {
      this._logDebug("Refreshing token via telnet...");
      const newToken = await this.client.getTokenFromTelnet();
      if (!newToken) throw new Error("Telnet did not return a new token");

      if (typeof this.client.setPin === 'function') {
        this.client.setPin(newToken);
      } else if (typeof this.client.updatePin === 'function') {
        this.client.updatePin(newToken);
      } else {
        this._logWarn("Client does not provide pin setter after telnet");
      }

      // Recreate client to avoid stale/corrupted state and attempt connect
      this.client = new WebSocketClient(this.options);
      await this.ensureConnected();
      this._logDebug("Reconnected after token refresh");
    } catch (err) {
      this._logError("refreshTokenAndReconnect failed:", err && err.message ? err.message : err);
      // Consider failure to refresh token a critical condition
      this._handleCriticalFailure(err);
      throw err;
    } finally {
      this.tokenUpdateInProgress = false;
    }
  }

  // ---------- Homebridge API ----------
  getServices() {
    this.service = new Service.Outlet(this.name);
    this.service.getCharacteristic(Characteristic.On)
      .on('get', this.getPowerState.bind(this))
      .on('set', this.setPowerState.bind(this));
    return [this.service];
  }

  _safeCallback(cb, err, val) {
    try { if (typeof cb === 'function') cb(err, val); } catch (e) { this._logWarn("Callback threw:", e && e.message ? e.message : e); }
  }

  async getPowerState(callback) {
    this._enqueueOperation(async () => {
      try {
        await this.ensureConnected();
        const state = await this.client.state();
        this._logDebug(`getPowerState: ${state ? "ON" : "OFF"}`);
        this._safeCallback(callback, null, state);
      } catch (error) {
        this._logWarn("getPowerState error:", error && error.message ? error.message : error);

        if (this._isTokenError(error) && this.useTelnetForToken) {
          this._logDebug("Token error in getPowerState -> attempting refresh+retry");
          try {
            await this.refreshTokenAndReconnect();
            const state = await this.client.state();
            this._logDebug(`getPowerState after refresh: ${state ? "ON" : "OFF"}`);
            this._safeCallback(callback, null, state);
            return;
          } catch (retryErr) {
            this._logError("Retry after token refresh failed in getPowerState:", retryErr && retryErr.message ? retryErr.message : retryErr);
            // If refresh retry fails, handle as critical depending on configuration
            this._handleCriticalFailure(retryErr);
            this._safeCallback(callback, retryErr);
            return;
          }
        }

        // Non-token error: if configured to force restart, escalate; else return error gracefully
        if (this.forceRestartOnFailure) {
          this._logError("getPowerState encountered non-token error and forceRestartOnFailure=true -> escalating");
          this._handleCriticalFailure(error);
        }
        this._safeCallback(callback, error);
      }
    }).catch(queueErr => {
      this._logError("Operation queue error in getPowerState:", queueErr && queueErr.message ? queueErr.message : queueErr);
      this._safeCallback(callback, queueErr);
    });
  }

  async setPowerState(value, callback) {
    this._enqueueOperation(async () => {
      try {
        await this.ensureConnected();
        await this.client.switch(value);
        this._logDebug(`setPowerState -> ${value ? "ON" : "OFF"}`);
        this._safeCallback(callback, null);
      } catch (error) {
        this._logWarn("setPowerState error:", error && error.message ? error.message : error);

        if (this._isTokenError(error) && this.useTelnetForToken) {
          this._logDebug("Token error in setPowerState -> attempting refresh+retry");
          try {
            await this.refreshTokenAndReconnect();
            await this.client.switch(value);
            this._logDebug("setPowerState success after token refresh");
            this._safeCallback(callback, null);
            return;
          } catch (retryErr) {
            this._logError("Retry after token refresh failed in setPowerState:", retryErr && retryErr.message ? retryErr.message : retryErr);
            this._handleCriticalFailure(retryErr);
            this._safeCallback(callback, retryErr);
            return;
          }
        }

        if (this.forceRestartOnFailure) {
          this._logError("setPowerState encountered non-token error and forceRestartOnFailure=true -> escalating");
          this._handleCriticalFailure(error);
        }
        this._safeCallback(callback, error);
      }
    }).catch(queueErr => {
      this._logError("Operation queue error in setPowerState:", queueErr && queueErr.message ? queueErr.message : queueErr);
      this._safeCallback(callback, queueErr);
    });
  }

  // Graceful shutdown helper
  shutdown() {
    this.shutdownRequested = true;
    this._clearTokenUpdateInterval();
    if (this.client && typeof this.client.close === 'function') {
      try {
        this.client.close();
        this._logDebug("Client closed on shutdown");
      } catch (e) {
        this._logWarn("Error closing client on shutdown:", e && e.message ? e.message : e);
      }
    }
  }
}

module.exports.DLinkSmartPlug = DLinkSmartPlug;
