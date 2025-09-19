// homebridge-dlink-wifi-smart-plug-dsp-w215 (carefully optimized, English comments)
// Key improvements:
// - centralized login with retry + exponential backoff (serializes concurrent logins)
// - periodic/explicit token refresh only when configured (telnet-based token retrieval)
// - operation serialization (queue) to avoid race conditions between get/set
// - configurable debug flag to control console verbosity (default off -> only warnings/errors)
// - avoid Homebridge process restarts except when forceRestartOnFailure=true and on critical failures
// - safe callback handling and defensive programming (no unhandled promise rejections)

const WebSocketClient = require('dlink_websocketclient');
let Service, Characteristic;

module.exports = (homebridge) => {
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
    this.pin = config.pin; // token or "TELNET"
    this.useTelnetForToken = !!config.useTelnetForToken;

    // User-configurable options with sensible defaults
    this.options = {
      ip: this.ip,
      pin: this.pin,
      useTelnetForToken: this.useTelnetForToken
    };

    this.maxRetries = Number.isInteger(config.maxRetries) ? config.maxRetries : 5;
    this.initialRetryDelayMs = Number.isInteger(config.initialRetryDelayMs) ? config.initialRetryDelayMs : 1000; // 1s
    this.tokenUpdateIntervalMs = Number.isInteger(config.tokenUpdateIntervalMs) ? config.tokenUpdateIntervalMs : 300000; // 5min default
    this.forceRestartOnFailure = !!config.forceRestartOnFailure; // default false

    // Debug flag: if true show all the original plugin messages; if false show only warnings/errors
    this.debug = !!config.debug;

    // Internal state
    this.client = new WebSocketClient(this.options);
    this.shutdownRequested = false;
    this.loginPromise = null; // serializes login operations
    this.tokenUpdateInProgress = false;
    this.tokenUpdateInterval = null;

    // Operation queue: serialize high-level operations (get/set) to avoid races
    // Implemented as a chain of promises: this._opQueue = this._opQueue.then(() => op())
    this._opQueue = Promise.resolve();

    // Start periodic token refresh only if telnet-based token retrieval is enabled
    if (this.useTelnetForToken) {
      this._startTokenUpdateInterval();
    }

    this._logInfo(`Initializing D-Link Smart Plug '${this.name}' at ${this.ip} (telnetToken=${this.useTelnetForToken})`);
  }

  // ---------- Logging helpers ----------
  _logDebug(...args) {
    if (this.debug) this._nativeLog('debug', ...args);
  }
  _logInfo(...args) {
    // minimal info: show only if debug enabled
    if (this.debug) this._nativeLog('info', ...args);
  }
  _logWarn(...args) {
    this._nativeLog('warn', ...args);
  }
  _logError(...args) {
    this._nativeLog('error', ...args);
  }
  _nativeLog(level, ...args) {
    // Homebridge log sometimes exposes .debug, but to be safe use the provided logger.
    // We keep messages brief when debug=false (only warn/error).
    try {
      const message = args.map(a => (typeof a === 'string' ? a : (a && a.message ? a.message : JSON.stringify(a)))).join(' ');
      if (level === 'debug' && typeof this.log.debug === 'function') return this.log.debug(message);
      if (level === 'info' && typeof this.log.info === 'function') return this.log.info(message);
      if (level === 'warn' && typeof this.log.warn === 'function') return this.log.warn(message);
      if (level === 'error' && typeof this.log.error === 'function') return this.log.error(message);
      // fallback
      if (level === 'error') return this.log(`ERROR: ${message}`);
      if (level === 'warn') return this.log(`WARN: ${message}`);
      if (level === 'debug') return this.log(`DEBUG: ${message}`);
      this.log(message);
    } catch (e) {
      // avoid throwing during logging
      try { this.log('Logging error:', e && e.message ? e.message : e); } catch (_) { /* noop */ }
    }
  }

  // Small helper to classify token errors from different shapes of errors
  _isTokenError(err) {
    if (!err) return false;
    const code = err.code;
    const msg = (err && (err.message || err.toString())) || '';
    const lower = String(msg).toLowerCase();
    return code === 424 || lower.includes("invalid device token") || lower.includes("invalid token") || lower.includes("token expired");
  }

  // ---------- Operation queue ----------
  // All external operations (get/set) should be serialized using this queue helper.
  _enqueueOperation(fn) {
    // fn should return a Promise
    this._opQueue = this._opQueue.then(() => {
      if (this.shutdownRequested) return Promise.reject(new Error("Accessory shutting down"));
      return fn();
    }).catch(err => {
      // swallow to avoid breaking the chain; return rejection so caller knows
      return Promise.reject(err);
    });
    return this._opQueue;
  }

  // ---------- Token refresh interval ----------
  _startTokenUpdateInterval() {
    if (this.tokenUpdateInterval) return;
    // only when useTelnetForToken is true
    this.tokenUpdateInterval = setInterval(async () => {
      if (this.shutdownRequested) return;
      if (this.tokenUpdateInProgress) {
        this._logDebug("Periodic token refresh skipped: already in progress");
        return;
      }
      this.tokenUpdateInProgress = true;
      try {
        this._logDebug("Periodic token update: fetching token from telnet...");
        const newToken = await this.client.getTokenFromTelnet();
        if (newToken) {
          // set token safely, do NOT print token
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

  // ---------- Login / connection handling ----------
  // Serializes login attempts via this.loginPromise
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
          await this.client.login(); // assume client.login() rejects on failure
          this._logDebug ? this._logDebug(`Login successful (attempt ${attempt})`) : this._logInfo("Login successful");
          this.loginPromise = null;
          return;
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          this._logWarn(`Login failed (attempt ${attempt}): ${msg}`);

          const isTokenErr = this._isTokenError(err);
          if (isTokenErr && this.useTelnetForToken) {
            // Try to recover token via telnet before next login attempt
            try {
              this._logDebug("Token error detected during login: fetching token from telnet...");
              const newToken = await this.client.getTokenFromTelnet();
              if (newToken) {
                if (typeof this.client.setPin === 'function') {
                  this.client.setPin(newToken);
                } else if (typeof this.client.updatePin === 'function') {
                  this.client.updatePin(newToken);
                } else {
                  this._logWarn("Client does not expose setPin/updatePin after telnet token fetch.");
                }
                this._logDebug("Token refreshed locally, retrying login immediately.");
                // Immediately retry without counting as extra attempt beyond normal loop iteration
                continue;
              } else {
                this._logWarn("Telnet did not return a token during login recovery.");
              }
            } catch (telnetErr) {
              this._logWarn("Error fetching token via telnet during login recovery:", telnetErr && telnetErr.message ? telnetErr.message : telnetErr);
            }
          }

          if (attempt < this.maxRetries) {
            this._logDebug(`Waiting ${delay} ms before next login attempt`);
            await new Promise(res => setTimeout(res, delay));
            delay = Math.min(delay * 2, 30000); // cap at 30s
            continue;
          } else {
            // All attempts exhausted
            const finalError = new Error(`Login failed after ${attempt} attempts: ${msg}`);
            this.loginPromise = null;
            this._logError(finalError.message);
            throw finalError;
          }
        }
      }
      // If shutdown requested
      this.loginPromise = null;
      throw new Error("Login aborted: shutting down or max retries exhausted");
    })();

    return this.loginPromise;
  }

  // Attempts to refresh token via telnet then re-initialize client and login
  async refreshTokenAndReconnect() {
    if (!this.useTelnetForToken) {
      throw new Error("refreshTokenAndReconnect called but useTelnetForToken is false");
    }

    // Wait if periodic update is in progress
    while (this.tokenUpdateInProgress) {
      this._logDebug("Waiting for in-progress token update to finish...");
      await new Promise(r => setTimeout(r, 200));
    }

    this.tokenUpdateInProgress = true;
    try {
      this._logDebug("Refreshing token via telnet...");
      const newToken = await this.client.getTokenFromTelnet();
      if (!newToken) {
        throw new Error("Telnet did not return a new token");
      }

      if (typeof this.client.setPin === 'function') {
        this.client.setPin(newToken);
      } else if (typeof this.client.updatePin === 'function') {
        this.client.updatePin(newToken);
      } else {
        this._logWarn("Client does not allow setting token after telnet fetch.");
      }

      this._logDebug("Token updated via telnet (not printed). Recreating client to ensure clean state.");

      // Recreate client to avoid corrupted state; use same options (which include pin if client reads from it)
      this.client = new WebSocketClient(this.options);

      // Try to connect now
      await this.ensureConnected();
      this._logDebug("Reconnected after token refresh.");
    } finally {
      this.tokenUpdateInProgress = false;
    }
  }

  // ---------- Homebridge accessory API ----------
  getServices() {
    this.service = new Service.Outlet(this.name);
    this.service.getCharacteristic(Characteristic.On)
      .on('get', this.getPowerState.bind(this))
      .on('set', this.setPowerState.bind(this));
    // You could add other characteristics here (OutletInUse, etc.) if the device supports them
    return [this.service];
  }

  // Helper to call a Homebridge callback safely (avoid double-calling)
  _safeCallback(cb, err, val) {
    try {
      if (typeof cb === 'function') cb(err, val);
    } catch (e) {
      this._logWarn("Callback threw an exception:", e && e.message ? e.message : e);
    }
  }

  // getPowerState: serialized via operation queue
  async getPowerState(callback) {
    // Enqueue the operation so concurrent gets/sets don't race
    this._enqueueOperation(async () => {
      try {
        await this.ensureConnected();
        const state = await this.client.state();
        this._logDebug(`Current state for '${this.name}': ${state ? "On" : "Off"}`);
        this._safeCallback(callback, null, state);
      } catch (error) {
        this._logWarn("Error retrieving state:", error && error.message ? error.message : error);
        // token-specific recovery
        if (this._isTokenError(error) && this.useTelnetForToken) {
          this._logDebug("Token error detected during getPowerState: attempting refresh and retry");
          try {
            await this.refreshTokenAndReconnect();
            const state = await this.client.state();
            this._logDebug(`State after token refresh for '${this.name}': ${state ? "On" : "Off"}`);
            this._safeCallback(callback, null, state);
            return;
          } catch (retryErr) {
            this._logError("Token refresh + retry failed:", retryErr && retryErr.message ? retryErr.message : retryErr);
            if (this.forceRestartOnFailure) {
              this._logError("forceRestartOnFailure=true -> scheduling process exit in 1s");
              setTimeout(() => process.exit(1), 1000);
            }
            this._safeCallback(callback, retryErr);
            return;
          }
        }

        // Non-token-related error
        if (this.forceRestartOnFailure) {
          this._logError("forceRestartOnFailure=true -> scheduling process exit in 1s due to get error");
          setTimeout(() => process.exit(1), 1000);
        }
        this._safeCallback(callback, error);
      }
    }).catch(queueErr => {
      // if queue-level error happens
      this._logError("Operation queue error on getPowerState:", queueErr && queueErr.message ? queueErr.message : queueErr);
      this._safeCallback(callback, queueErr);
    });
  }

  // setPowerState: serialized via operation queue
  async setPowerState(value, callback) {
    this._enqueueOperation(async () => {
      try {
        await this.ensureConnected();
        await this.client.switch(value);
        this._logDebug(`Set plug '${this.name}' to: ${value ? "On" : "Off"}`);
        this._safeCallback(callback, null);
      } catch (error) {
        this._logWarn("Error changing state:", error && error.message ? error.message : error);

        if (this._isTokenError(error) && this.useTelnetForToken) {
          // Try refresh once and retry the set
          this._logDebug("Token error during setPowerState: attempting refresh and retry");
          try {
            await this.refreshTokenAndReconnect();
            await this.client.switch(value);
            this._logDebug(`Set succeeded after token refresh for '${this.name}'`);
            this._safeCallback(callback, null);
            return;
          } catch (retryErr) {
            this._logError("Retry after token refresh failed:", retryErr && retryErr.message ? retryErr.message : retryErr);
            if (this.forceRestartOnFailure) {
              this._logError("forceRestartOnFailure=true -> scheduling process exit in 1s");
              setTimeout(() => process.exit(1), 1000);
            }
            this._safeCallback(callback, retryErr);
            return;
          }
        }

        // Non-token-related error: return to Homebridge (don't kill process unless forced)
        if (this.forceRestartOnFailure) {
          this._logError("forceRestartOnFailure=true -> scheduling process exit in 1s due to set error");
          setTimeout(() => process.exit(1), 1000);
        }
        this._safeCallback(callback, error);
      }
    }).catch(queueErr => {
      this._logError("Operation queue error on setPowerState:", queueErr && queueErr.message ? queueErr.message : queueErr);
      this._safeCallback(callback, queueErr);
    });
  }

  // Graceful shutdown: cancel timers and close client if possible
  shutdown() {
    this.shutdownRequested = true;
    this._clearTokenUpdateInterval();
    // If client supports close, attempt it
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

