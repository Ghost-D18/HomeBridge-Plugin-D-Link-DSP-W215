// homebridge-dlink-wifi-smart-plug-dsp-w215 (updated)
// - Adds operationTimeoutMs for get/set to avoid Homebridge blocking/warnings
// - Suppresses verbose token error messages when debug=false (compact message instead)
// - Preserves prior improvements: serialized login, token refresh, child-bridge aware restart, queueing, etc.

const WebSocketClient = require('dlink_websocketclient');
let Service, Characteristic, HOMEBRIDGE_API;

module.exports = (homebridge) => {
  HOMEBRIDGE_API = homebridge;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory("homebridge-dlink-wifi-smart-plug-dsp-w215", "DLinkSmartPlug", DLinkSmartPlug);
};

class DLinkSmartPlug {
  constructor(log, config = {}) {
    // Basic identity
    this.log = log;
    this.name = config.name || "D-Link Smart Plug";
    this.ip = config.ip;
    this.pin = config.pin;
    this.useTelnetForToken = !!config.useTelnetForToken;

    // Options forwarded to client
    this.options = {
      ip: this.ip,
      pin: this.pin,
      useTelnetForToken: this.useTelnetForToken
    };

    // Retry / timing config
    this.maxRetries = Number.isInteger(config.maxRetries) ? config.maxRetries : 5;
    this.initialRetryDelayMs = Number.isInteger(config.initialRetryDelayMs) ? config.initialRetryDelayMs : 1000;
    this.tokenUpdateIntervalMs = Number.isInteger(config.tokenUpdateIntervalMs) ? config.tokenUpdateIntervalMs : 300000;
    this.operationTimeoutMs = Number.isInteger(config.operationTimeoutMs) ? config.operationTimeoutMs : 5000; // NEW: timeout for get/set

    // Restart behaviour and logging
    this.forceRestartOnFailure = !!config.forceRestartOnFailure;
    this.debug = !!config.debug;

    // Child-bridge detection (explicit override or best-effort autodetect)
    this.runningAsChildBridge = false;
    if (typeof config.childBridge === 'boolean') {
      this.runningAsChildBridge = config.childBridge;
    } else {
      try {
        if (HOMEBRIDGE_API && typeof HOMEBRIDGE_API.isChildBridge === 'boolean') {
          this.runningAsChildBridge = HOMEBRIDGE_API.isChildBridge;
        } else if (HOMEBRIDGE_API && HOMEBRIDGE_API.server && typeof HOMEBRIDGE_API.server.name === 'string') {
          const sn = HOMEBRIDGE_API.server.name.toLowerCase();
          if (sn.includes('child') || sn.includes('bridge')) this.runningAsChildBridge = true;
        }
        if (!this.runningAsChildBridge && process.env.HOMEBRIDGE_CHILD === '1') this.runningAsChildBridge = true;
      } catch (e) {
        this.runningAsChildBridge = false;
      }
    }

    // Internal state
    this.client = new WebSocketClient(this.options);
    this.shutdownRequested = false;
    this.loginPromise = null; // serializes login attempts
    this.tokenUpdateInProgress = false;
    this.tokenUpdateInterval = null;
    this._opQueue = Promise.resolve(); // operation queue

    // Start periodic token update if telnet token usage is enabled
    if (this.useTelnetForToken) this._startTokenUpdateInterval();

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
  _handleCriticalFailure(reason) {
    const msg = reason && (reason.message || reason.toString()) ? (reason.message || reason.toString()) : String(reason);
    this._logError("CRITICAL: unrecoverable error:", msg);

    if (this.runningAsChildBridge) {
      this._logError("Accessory configured as child-bridge -> scheduling child-bridge restart (exit 2) in 1s");
      setTimeout(() => { try { process.exit(2); } catch (e) {} }, 1000);
      return;
    }

    if (this.forceRestartOnFailure) {
      this._logError("forceRestartOnFailure=true -> scheduling full Homebridge restart (exit 1) in 1s");
      setTimeout(() => { try { process.exit(1); } catch (e) {} }, 1000);
      return;
    }

    this._logWarn("Not configured to restart (neither childBridge nor forceRestartOnFailure). Plugin will remain loaded but in degraded mode.");
  }

  // ---------- Operation queue ----------
  _enqueueOperation(fn) {
    this._opQueue = this._opQueue.then(() => {
      if (this.shutdownRequested) return Promise.reject(new Error("Accessory shutting down"));
      return fn();
    }).catch(err => {
      // keep chain alive but forward rejection
      return Promise.reject(err);
    });
    return this._opQueue;
  }

  // ---------- Token refresh interval ----------
  _startTokenUpdateInterval() {
    if (this.tokenUpdateInterval) return;
    this.tokenUpdateInterval = setInterval(async () => {
      if (this.shutdownRequested) return;
      if (this.tokenUpdateInProgress) { this._logDebug("Periodic token update skipped: already in progress"); return; }
      this.tokenUpdateInProgress = true;
      try {
        this._logDebug("Periodic token update: fetching token from telnet...");
        const newToken = await this.client.getTokenFromTelnet();
        if (newToken) {
          if (typeof this.client.setPin === 'function') {
            this.client.setPin(newToken);
          } else if (typeof this.client.updatePin === 'function') {
            this.client.updatePin(newToken);
          } else {
            this._logWarn("Client does not expose setPin/updatePin to update token.");
          }
          this._logDebug("Periodic token update: token updated (not shown).");
        } else {
          this._logWarn("Periodic token update: telnet did not return a token.");
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
      this._logDebug("Login already in progress, awaiting existing promise");
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
            try {
              this._logDebug("Token error detected during login: fetching token via telnet...");
              const newToken = await this.client.getTokenFromTelnet();
              if (newToken) {
                if (typeof this.client.setPin === 'function') {
                  this.client.setPin(newToken);
                } else if (typeof this.client.updatePin === 'function') {
                  this.client.updatePin(newToken);
                }
                this._logDebug("Token refreshed locally, retrying login immediately.");
                continue;
              } else {
                this._logWarn("Telnet did not return a token during login recovery.");
              }
            } catch (telnetErr) {
              this._logWarn("Error fetching token via telnet during login recovery:", telnetErr && telnetErr.message ? telnetErr.message : telnetErr);
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
        this._logWarn("Client does not allow setting token after telnet fetch.");
      }

      this.client = new WebSocketClient(this.options);
      await this.ensureConnected();
      this._logDebug("Reconnected after token refresh.");
    } catch (err) {
      this._logError("refreshTokenAndReconnect failed:", err && err.message ? err.message : err);
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
    try { if (typeof cb === 'function') cb(err, val); } catch (e) { this._logWarn("Callback threw an exception:", e && e.message ? e.message : e); }
  }

  // ---------- getPowerState with operation timeout and token-suppressed logging ----------
  async getPowerState(callback) {
    let responded = false;
    const timeoutMs = this.operationTimeoutMs || 5000;

    const timeoutHandle = setTimeout(() => {
      responded = true;
      const err = new Error(`Timeout: device did not respond within ${timeoutMs}ms`);
      this._logWarn("getPowerState timed out:", err.message);
      this._safeCallback(callback, err);
    }, timeoutMs);

    this._enqueueOperation(async () => {
      try {
        await this.ensureConnected();
        const state = await this.client.state();
        this._logDebug(`getPowerState actual result: ${state ? "ON" : "OFF"}`);

        if (!responded) {
          clearTimeout(timeoutHandle);
          responded = true;
          this._safeCallback(callback, null, state);
        } else {
          this._logDebug("getPowerState response arrived after timeout; ignoring callback.");
        }
      } catch (error) {
        if (this._isTokenError(error)) {
          // Token errors: show compact message when debug=false; full details only when debug=true
          if (this.debug) {
            this._logWarn("getPowerState error (token):", error && error.message ? error.message : error);
          } else {
            this._logWarn("getPowerState error: token invalid (enable debug for details)");
            this._logDebug("getPowerState token error details:", error && error.message ? error.message : error);
          }

          if (!responded) {
            try {
              await this.refreshTokenAndReconnect();
              const state = await this.client.state();
              if (!responded) {
                clearTimeout(timeoutHandle);
                responded = true;
                this._safeCallback(callback, null, state);
              }
              return;
            } catch (retryErr) {
              if (this.debug) {
                this._logError("getPowerState: token refresh+retry failed:", retryErr && retryErr.message ? retryErr.message : retryErr);
              } else {
                this._logWarn("getPowerState: token refresh failed (enable debug for details)");
                this._logDebug("getPowerState token refresh error details:", retryErr && retryErr.message ? retryErr.message : retryErr);
              }
              if (!responded) {
                clearTimeout(timeoutHandle);
                responded = true;
                this._safeCallback(callback, retryErr);
              }
              return;
            }
          } else {
            this._logDebug("getPowerState token error occurred after callback timeout; background recovery attempted.");
            return;
          }
        } else {
          // Non-token error
          this._logWarn("getPowerState error:", error && error.message ? error.message : error);
          if (!responded) {
            clearTimeout(timeoutHandle);
            responded = true;
            if (this.forceRestartOnFailure) {
              this._logError("getPowerState non-token error and forceRestartOnFailure=true -> escalate");
              this._handleCriticalFailure(error);
            }
            this._safeCallback(callback, error);
          } else {
            this._logDebug("Non-token error occurred after timeout; ignored.");
          }
        }
      }
    }).catch(queueErr => {
      clearTimeout(timeoutHandle);
      if (!responded) {
        responded = true;
        this._logError("Operation queue error in getPowerState:", queueErr && queueErr.message ? queueErr.message : queueErr);
        this._safeCallback(callback, queueErr);
      }
    });
  }

  // ---------- setPowerState with operation timeout and token-suppressed logging ----------
  async setPowerState(value, callback) {
    let responded = false;
    const timeoutMs = this.operationTimeoutMs || 5000;

    const timeoutHandle = setTimeout(() => {
      responded = true;
      const err = new Error(`Timeout: device did not respond within ${timeoutMs}ms`);
      this._logWarn("setPowerState timed out:", err.message);
      this._safeCallback(callback, err);
    }, timeoutMs);

    this._enqueueOperation(async () => {
      try {
        await this.ensureConnected();
        await this.client.switch(value);
        this._logDebug(`setPowerState actual success -> ${value ? "ON" : "OFF"}`);

        if (!responded) {
          clearTimeout(timeoutHandle);
          responded = true;
          this._safeCallback(callback, null);
        } else {
          this._logDebug("setPowerState succeeded after timeout; ignoring callback.");
        }
      } catch (error) {
        if (this._isTokenError(error)) {
          if (this.debug) {
            this._logWarn("setPowerState error (token):", error && error.message ? error.message : error);
          } else {
            this._logWarn("setPowerState error: token invalid (enable debug for details)");
            this._logDebug("setPowerState token error details:", error && error.message ? error.message : error);
          }

          if (!responded) {
            try {
              await this.refreshTokenAndReconnect();
              await this.client.switch(value);
              if (!responded) {
                clearTimeout(timeoutHandle);
                responded = true;
                this._safeCallback(callback, null);
              }
              return;
            } catch (retryErr) {
              if (this.debug) {
                this._logError("setPowerState: retry after token refresh failed:", retryErr && retryErr.message ? retryErr.message : retryErr);
              } else {
                this._logWarn("setPowerState: token retry failed (enable debug for details)");
                this._logDebug("setPowerState token retry details:", retryErr && retryErr.message ? retryErr.message : retryErr);
              }
              if (!responded) {
                clearTimeout(timeoutHandle);
                responded = true;
                this._safeCallback(callback, retryErr);
              }
              return;
            }
          } else {
            this._logDebug("setPowerState token error occurred after callback timeout; background retry in progress.");
            return;
          }
        } else {
          // Non-token error
          this._logWarn("setPowerState error:", error && error.message ? error.message : error);
          if (!responded) {
            clearTimeout(timeoutHandle);
            responded = true;
            if (this.forceRestartOnFailure) {
              this._logError("setPowerState non-token error and forceRestartOnFailure=true -> escalate");
              this._handleCriticalFailure(error);
            }
            this._safeCallback(callback, error);
          } else {
            this._logDebug("Non-token setPowerState error occurred after timeout; ignored.");
          }
        }
      }
    }).catch(queueErr => {
      clearTimeout(timeoutHandle);
      if (!responded) {
        responded = true;
        this._logError("Operation queue error in setPowerState:", queueErr && queueErr.message ? queueErr.message : queueErr);
        this._safeCallback(callback, queueErr);
      }
    });
  }

  // ---------- Shutdown ----------
  shutdown() {
    this.shutdownRequested = true;
    this._clearTokenUpdateInterval();
    if (this.client && typeof this.client.close === 'function') {
      try {
        this.client.close();
        this._logDebug("WebSocket client closed during shutdown");
      } catch (e) {
        this._logWarn("Error closing WebSocket client during shutdown:", e && e.message ? e.message : e);
      }
    }
  }
}
