const WebSocketClient = require('dlink_websocketclient');
let Service, Characteristic;

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory("homebridge-dlink", "DLinkSmartPlug", DLinkSmartPlug);
};

class DLinkSmartPlug {
  constructor(log, config) {
    this.log = log;
    this.name = config.name || "D-Link Smart Plug";
    this.ip = config.ip;
    this.pin = config.pin; // Inserisci qui il PIN o il token fisso (usa "TELNET" se vuoi aggiornare automaticamente)
    this.useTelnetForToken = config.useTelnetForToken || false;
    
    this.options = {
      ip: this.ip,
      pin: this.pin,
      useTelnetForToken: this.useTelnetForToken
    };

    this.log(`Inizializzazione della presa '${this.name}' su IP ${this.ip} con opzioni: ${JSON.stringify(this.options)}`);
    this.client = new WebSocketClient(this.options);
    
    // Se l'opzione per aggiornamento automatico è abilitata, avvia l'intervallo
    if (this.useTelnetForToken) {
      this.startTokenUpdateInterval();
    }
  }

  startTokenUpdateInterval() {
    // Aggiorna il token ogni 1 secondo (1000 ms)
    this.tokenUpdateInterval = setInterval(() => {
      if (this.tokenUpdateInProgress) return;
      this.tokenUpdateInProgress = true;
      this.client.getTokenFromTelnet()
        .then(newToken => {
          this.client.setPin(newToken);
          // Non stampiamo il token per non appesantire il log
        })
        .catch(error => {
          this.log("Errore nell'aggiornamento del token:", error);
        })
        .finally(() => {
          this.tokenUpdateInProgress = false;
        });
    }, 1000);
  }

  getServices() {
    this.service = new Service.Outlet(this.name);
    this.service.getCharacteristic(Characteristic.On)
      .on('get', this.getPowerState.bind(this))
      .on('set', this.setPowerState.bind(this));
    return [this.service];
  }

  async getPowerState(callback) {
    try {
      await this.client.login();
      const state = await this.client.state();
      this.log(`Stato attuale della presa '${this.name}': ${state ? "Accesa" : "Spenta"}`);
      callback(null, state);
    } catch (error) {
      this.log("Errore nel recuperare lo stato:", error);
      // Se l'errore è quello che serve per riprendere il token (API Error 424) lo gestiamo normalmente
      if (error.code === 424 || (error.message && error.message.includes("invalid device token"))) {
        this.log("API Error 424 rilevato: token non valido. Forzo riconnessione...");
        try {
          this.client = new WebSocketClient(this.options);
          await this.client.login();
          const state = await this.client.state();
          this.log(`Dopo riconnessione, stato della presa '${this.name}': ${state ? "Accesa" : "Spenta"}`);
          callback(null, state);
        } catch (forcedError) {
          this.log("Errore durante il tentativo forzato di riconnessione:", forcedError);
          // Per ogni errore in questa gestione, forziamo il riavvio del processo
          setTimeout(() => { process.exit(1); }, 1000);
          callback(forcedError);
        }
      } else {
        // Per ogni altro errore, forziamo il riavvio dell'intero processo Homebridge
        this.log("Errore non gestito rilevato. Riavvio il plugin...");
        setTimeout(() => { process.exit(1); }, 1000);
        callback(error);
      }
    }
  }

  async setPowerState(value, callback) {
    try {
      await this.client.login();
      await this.client.switch(value);
      this.log(`Imposto lo stato della presa '${this.name}' a: ${value ? "Accesa" : "Spenta"}`);
      callback(null);
    } catch (error) {
      this.log("Errore nel cambiare lo stato:", error);
      // Se l'errore non è quello per cui abbiamo implementato la riconnessione del token, riavviamo
      if (!(error.code === 424 || (error.message && error.message.includes("invalid device token")))) {
        this.log("Errore non gestito durante il cambio stato. Riavvio il plugin...");
        setTimeout(() => { process.exit(1); }, 1000);
      }
      callback(error);
    }
  }
  
  shutdown() {
    if (this.tokenUpdateInterval) {
      clearInterval(this.tokenUpdateInterval);
    }
  }
}
