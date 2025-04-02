const WebSocketClient = require('dlink_websocketclient');
let Service, Characteristic;

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  homebridge.registerAccessory("homebridge-dlink-dsp-w215-control", "DLinkSmartPlug", DLinkSmartPlug);
};

class DLinkSmartPlug {
  constructor(log, config) {
    this.log = log;
    this.name = config.name || "D-Link Smart Plug";
    this.ip = config.ip;
    this.pin = config.pin; // Enter the PIN or fixed token here (use "TELNET" if you want to update automatically)
    this.useTelnetForToken = config.useTelnetForToken || false;
    
    this.options = {
      ip: this.ip,
      pin: this.pin,
      useTelnetForToken: this.useTelnetForToken
    };

    this.log(`Initializing plug '${this.name}' on IP ${this.ip} with options: ${JSON.stringify(this.options)}`);
    this.client = new WebSocketClient(this.options);
    
    // If the option for automatic update is enabled, start the interval
    if (this.useTelnetForToken) {
      this.startTokenUpdateInterval();
    }
  }

  startTokenUpdateInterval() {
    // Update the token every 1 second (1000 ms)
    this.tokenUpdateInterval = setInterval(() => {
      if (this.tokenUpdateInProgress) return;
      this.tokenUpdateInProgress = true;
      this.client.getTokenFromTelnet()
        .then(newToken => {
          this.client.setPin(newToken);
          // We do not print the token to avoid cluttering the log
        })
        .catch(error => {
          this.log("Error updating token:", error);
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
      this.log(`Current state of plug '${this.name}': ${state ? "On" : "Off"}`);
      callback(null, state);
    } catch (error) {
      this.log("Error retrieving state:", error);
      // If the error requires token retrieval (API Error 424), handle it normally
      if (error.code === 424 || (error.message && error.message.includes("invalid device token"))) {
        this.log("API Error 424 detected: invalid token. Forcing reconnection...");
        try {
          this.client = new WebSocketClient(this.options);
          await this.client.login();
          const state = await this.client.state();
          this.log(`After reconnection, plug '${this.name}' state: ${state ? "On" : "Off"}`);
          callback(null, state);
        } catch (forcedError) {
          this.log("Error during forced reconnection attempt:", forcedError);
          // For any error in this handling, force a process restart
          setTimeout(() => { process.exit(1); }, 1000);
          callback(forcedError);
        }
      } else {
        // For any other error, force a restart of the entire Homebridge process
        this.log("Unhandled error detected. Restarting the plugin...");
        setTimeout(() => { process.exit(1); }, 1000);
        callback(error);
      }
    }
  }

  async setPowerState(value, callback) {
    try {
      await this.client.login();
      await this.client.switch(value);
      this.log(`Setting plug '${this.name}' state to: ${value ? "On" : "Off"}`);
      callback(null);
    } catch (error) {
      this.log("Error changing state:", error);
      // If the error is not related to token reconnection, restart the plugin
      if (!(error.code === 424 || (error.message && error.message.includes("invalid device token")))) {
        this.log("Unhandled error during state change. Restarting the plugin...");
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
