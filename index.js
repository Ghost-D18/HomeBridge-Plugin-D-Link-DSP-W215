// homebridge-dlink-wifi-smart-plug-dsp-w215 (ottimizzato)
// Principali miglioramenti:
// - gestione centralizzata degli accessi/login con retry + backoff
// - refresh token solo quando serve e intervallo configurabile
// - meno riavvii di Homebridge (configurabile)
// - serializzazione delle operazioni per evitare race conditions

const WebSocketClient = require('dlink_websocketclient');
let Service, Characteristic;

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory("homebridge-dlink-wifi-smart-plug-dsp-w215", "DLinkSmartPlug", DLinkSmartPlug);
};

class DLinkSmartPlug {
  constructor(log, config) {
    this.log = log;
    this.name = config.name || "D-Link Smart Plug";
    this.ip = config.ip;
    this.pin = config.pin; // PIN / token oppure "TELNET"
    this.useTelnetForToken = config.useTelnetForToken || false;

    // Config ottimizzazione
    this.options = {
      ip: this.ip,
      pin: this.pin,
      useTelnetForToken: this.useTelnetForToken
    };

    this.maxRetries = config.maxRetries || 5;
    this.initialRetryDelayMs = config.initialRetryDelayMs || 1000; // 1s
    this.forceRestartOnFailure = config.forceRestartOnFailure || false; // mantiene vecchio comportamento se true
    // default token update ogni 5 minuti = 300000 ms (non 1s)
    this.tokenUpdateIntervalMs = config.tokenUpdateIntervalMs || 300000;

    this.log(`Initializing plug '${this.name}' on IP ${this.ip} (useTelnetForToken=${this.useTelnetForToken})`);

    this.client = new WebSocketClient(this.options);

    // Stato interno
    this.shutdownRequested = false;
    this.loginPromise = null; // serializza i login
    this.tokenUpdateInProgress = false;

    if (this.useTelnetForToken) {
      this.startTokenUpdateInterval();
    }
  }

  startTokenUpdateInterval() {
    if (this.tokenUpdateInterval) return; // già attivo
    // Aggiorniamo il token a intervalli ragionevoli configurabili (default 5 min)
    this.tokenUpdateInterval = setInterval(async () => {
      if (this.tokenUpdateInProgress) return;
      this.tokenUpdateInProgress = true;
      try {
        this.log("Periodic token update: fetching token from telnet...");
        const newToken = await this.client.getTokenFromTelnet();
        if (newToken) {
          // Impostiamo il PIN sul client senza stamparlo in log
          if (typeof this.client.setPin === 'function') {
            this.client.setPin(newToken);
          } else {
            // se l'API è diversa, provare setPin o updatePin
            if (typeof this.client.updatePin === 'function') {
              this.client.updatePin(newToken);
            }
          }
          this.log("Periodic token update: token updated (not shown in logs).");
        } else {
          this.log("Periodic token update: telnet did not return a token.");
        }
      } catch (err) {
        this.log("Periodic token update error:", err && err.message ? err.message : err);
      } finally {
        this.tokenUpdateInProgress = false;
      }
    }, this.tokenUpdateIntervalMs);
  }

  clearTokenUpdateInterval() {
    if (this.tokenUpdateInterval) {
      clearInterval(this.tokenUpdateInterval);
      this.tokenUpdateInterval = null;
    }
  }

  // centralizza login con retry + backoff; serializza invocazioni concurrenti
  async ensureConnected() {
    if (this.shutdownRequested) throw new Error("Accessory shutting down");

    // Se un login è già in corso, aspettiamo il suo risultato (serializzazione)
    if (this.loginPromise) return this.loginPromise;

    this.loginPromise = (async () => {
      let attempt = 0;
      let delay = this.initialRetryDelayMs;
      while (attempt < this.maxRetries) {
        attempt++;
        try {
          // prova a fare login
          await this.client.login();
          // login ok
          this.log.debug ? this.log.debug(`Login riuscito al tentativo ${attempt}`) : this.log(`Login riuscito (tentativo ${attempt})`);
          this.loginPromise = null;
          return;
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          this.log(`Login fallito (attempt ${attempt}): ${msg}`);
          // se è un errore di token, proviamo prima a refreshare il token (solo se abilitato)
          const isTokenError = (err && err.code === 424) || (msg && msg.toLowerCase().includes("invalid device token")) || (msg && msg.toLowerCase().includes("invalid token"));
          if (isTokenError && this.useTelnetForToken) {
            try {
              this.log("Token non valido rilevato: provo a recuperare token via telnet...");
              const newToken = await this.client.getTokenFromTelnet();
              if (newToken) {
                if (typeof this.client.setPin === 'function') {
                  this.client.setPin(newToken);
                } else if (typeof this.client.updatePin === 'function') {
                  this.client.updatePin(newToken);
                }
                this.log("Token aggiornato localmente. Ritento il login immediatamente.");
                // subito riproviamo (non incrementare attempt oltre normale)
                continue;
              } else {
                this.log("Recupero token via telnet non ha restituito token.");
              }
            } catch (telnetErr) {
              this.log("Errore recupero token via telnet:", telnetErr && telnetErr.message ? telnetErr.message : telnetErr);
            }
          }

          // backoff prima del prossimo tentativo
          if (attempt < this.maxRetries) {
            this.log(`Attendo ${delay}ms prima del prossimo tentativo di login...`);
            await new Promise(res => setTimeout(res, delay));
            delay = Math.min(delay * 2, 30000); // cap a 30s
            continue;
          } else {
            // ultimo tentativo fallito -> gestiamo in modo più morbido
            const e = new Error(`Login fallito dopo ${attempt} tentativi: ${msg}`);
            // puliamo loginPromise prima di lanciare
            this.loginPromise = null;
            throw e;
          }
        }
      }
    })();

    return this.loginPromise;
  }

  // Tentativo di refresh token e riconnessione immediata (usato in gestione errori)
  async refreshTokenAndReconnect() {
    if (!this.useTelnetForToken) {
      throw new Error("refreshTokenAndReconnect called but useTelnetForToken is false");
    }
    if (this.tokenUpdateInProgress) {
      // Se già in corso, aspettiamo che finisca e poi tentiamo login
      while (this.tokenUpdateInProgress) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    this.tokenUpdateInProgress = true;
    try {
      const newToken = await this.client.getTokenFromTelnet();
      if (!newToken) throw new Error("Telnet did not return a new token");
      if (typeof this.client.setPin === 'function') {
        this.client.setPin(newToken);
      } else if (typeof this.client.updatePin === 'function') {
        this.client.updatePin(newToken);
      }
      this.log("Token aggiornato via telnet (non mostrato in log). Provo a riconnettere.");
      // ricrea client pulito per evitare stato corrotto
      this.client = new WebSocketClient(this.options);
      await this.ensureConnected();
    } finally {
      this.tokenUpdateInProgress = false;
    }
  }

  // getServices rimane invariato nella API
  getServices() {
    this.service = new Service.Outlet(this.name);
    this.service.getCharacteristic(Characteristic.On)
      .on('get', this.getPowerState.bind(this))
      .on('set', this.setPowerState.bind(this));
    return [this.service];
  }

  async getPowerState(callback) {
    try {
      await this.ensureConnected();
      const state = await this.client.state();
      this.log(`Current state of plug '${this.name}': ${state ? "On" : "Off"}`);
      callback(null, state);
    } catch (error) {
      this.log("Error retrieving state:", error && error.message ? error.message : error);
      const msg = error && error.message ? error.message : "";
      const isTokenError = (error && error.code === 424) || (msg && msg.toLowerCase().includes("invalid device token")) || (msg && msg.toLowerCase().includes("invalid token"));
      if (isTokenError && this.useTelnetForToken) {
        this.log("Token non valido rilevato durante get: provo refresh token e retry");
        try {
          await this.refreshTokenAndReconnect();
          const state = await this.client.state();
          this.log(`Dopo refresh, stato plug '${this.name}': ${state ? "On" : "Off"}`);
          callback(null, state);
          return;
        } catch (forcedError) {
          this.log("Tentativo di refresh token/riconnessione fallito:", forcedError && forcedError.message ? forcedError.message : forcedError);
          // fallback: se forziamo restart via config, facciamolo, altrimenti ritorniamo errore all'homebridge senza kill
          if (this.forceRestartOnFailure) {
            this.log("forceRestartOnFailure=true -> riavviando processo in 1s");
            setTimeout(() => { process.exit(1); }, 1000);
          }
          callback(forcedError);
          return;
        }
      } else {
        this.log("Errore non correlato al token. Non riavvio immediatamente; ritorno errore a Homebridge.");
        if (this.forceRestartOnFailure) {
          this.log("forceRestartOnFailure=true -> riavviando processo in 1s");
          setTimeout(() => { process.exit(1); }, 1000);
        }
        callback(error);
      }
    }
  }

  async setPowerState(value, callback) {
    try {
      await this.ensureConnected();
      await this.client.switch(value);
      this.log(`Setting plug '${this.name}' state to: ${value ? "On" : "Off"}`);
      callback(null);
    } catch (error) {
      this.log("Error changing state:", error && error.message ? error.message : error);
      const msg = error && error.message ? error.message : "";
      const isTokenError = (error && error.code === 424) || (msg && msg.toLowerCase().includes("invalid device token")) || (msg && msg.toLowerCase().includes("invalid token"));
      if (isTokenError && this.useTelnetForToken) {
        // proviamo a refreshare il token e a ritentare una volta
        this.log("Token non valido durante set: provo refresh token e retry");
        try {
          await this.refreshTokenAndReconnect();
          await this.client.switch(value);
          this.log(`Dopo refresh, set riuscito per '${this.name}'`);
          callback(null);
          return;
        } catch (e) {
          this.log("Retry dopo refresh token fallito:", e && e.message ? e.message : e);
          if (this.forceRestartOnFailure) {
            this.log("forceRestartOnFailure=true -> riavvio processo in 1s");
            setTimeout(() => { process.exit(1); }, 1000);
          }
          callback(e);
          return;
        }
      } else {
        // Errore non token-related: non uccidiamo HB automaticamente, restituiamo errore
        this.log("Errore non correlato al token durante set. Restituisco l'errore a Homebridge.");
        if (this.forceRestartOnFailure) {
          this.log("forceRestartOnFailure=true -> riavvio processo in 1s");
          setTimeout(() => { process.exit(1); }, 1000);
        }
        callback(error);
      }
    }
  }

  shutdown() {
    this.shutdownRequested = true;
    this.clearTokenUpdateInterval();
    // opzionale: chiudi client se c'è API per farlo
    if (this.client && typeof this.client.close === 'function') {
      try { this.client.close(); } catch(e) { /* ignore */ }
    }
  }
}
