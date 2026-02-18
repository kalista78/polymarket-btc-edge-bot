const WebSocket = require("ws");
const EventEmitter = require("events");
const config = require("../config");
const log = require("../utils/logger");
const { getWsAgent } = require("../utils/proxy");

const TAG = "RTDS";

class RtdsClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.pingInterval = null;
    this.watchdogTimer = null;
    this.lastDataTime = 0;
    this.reconnectDelay = config.reconnectBaseMs;
    this.connected = false;
    this.intentionalClose = false;
    this.lastRateLimitAt = 0;
  }

  connect() {
    this.intentionalClose = false;
    log.info(TAG, "Connecting to Polymarket RTDS...");

    const wsOpts = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Origin: "https://polymarket.com",
      },
    };
    const agent = getWsAgent();
    if (agent) wsOpts.agent = agent;

    this.ws = new WebSocket(config.rtdsUrl, wsOpts);

    this.ws.on("open", () => {
      log.info(TAG, "Connected");
      this.connected = true;
      this.reconnectDelay = config.reconnectBaseMs;

      // Subscribe to Binance BTC
      this.ws.send(
        JSON.stringify({
          action: "subscribe",
          subscriptions: [
            {
              topic: "crypto_prices",
              type: "update",
              filters: JSON.stringify({ symbol: "btcusdt" }),
            },
          ],
        })
      );

      // Stagger Chainlink subscription slightly
      setTimeout(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(
            JSON.stringify({
              action: "subscribe",
              subscriptions: [
                {
                  topic: "crypto_prices_chainlink",
                  type: "update",
                  filters: JSON.stringify({ symbol: "btc/usd" }),
                },
              ],
            })
          );
        }
      }, 500);

      this._startPing();
      this._startWatchdog();
      this.emit("connected");
    });

    this.ws.on("message", (data) => {
      this.lastDataTime = Date.now();
      const str = data.toString();
      if (!str || str.length < 5) return; // pong

      let msg;
      try {
        msg = JSON.parse(str);
      } catch {
        return;
      }

      if (!msg.payload) return;

      const topic = msg.topic || "";
      const payload = msg.payload;
      let entries = [];

      // Batch format
      if (payload.data && Array.isArray(payload.data)) {
        entries = payload.data;
      }
      // Single format
      else if (payload.timestamp !== undefined && payload.value !== undefined) {
        entries = [payload];
      }

      for (const entry of entries) {
        if (!entry.timestamp || entry.value === undefined) continue;

        const price = parseFloat(entry.value);
        const timestamp = entry.timestamp;

        if (topic === "crypto_prices") {
          this.emit("binance-price", { price, timestamp });
        } else if (topic === "crypto_prices_chainlink") {
          this.emit("chainlink-price", { price, timestamp });
        }
      }
    });

    this.ws.on("error", (err) => {
      if (typeof err.message === "string" && err.message.includes("429")) {
        this.lastRateLimitAt = Date.now();
      }
      log.error(TAG, `WebSocket error: ${err.message}`);
    });

    this.ws.on("close", (code) => {
      this.connected = false;
      this._stopPing();
      this._stopWatchdog();

      if (this.intentionalClose) {
        log.info(TAG, `Disconnected (code: ${code})`);
        return;
      }

      const recentlyRateLimited = Date.now() - this.lastRateLimitAt < 15000;
      const baseDelay = recentlyRateLimited
        ? Math.max(this.reconnectDelay, config.rateLimitCooldownMs)
        : this.reconnectDelay;
      const jitteredDelay = Math.floor(baseDelay * (0.8 + Math.random() * 0.4));

      log.warn(TAG, `Disconnected (code: ${code}), reconnecting in ${jitteredDelay}ms`);
      setTimeout(() => this._reconnect(), jitteredDelay);
    });
  }

  _reconnect() {
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, config.reconnectMaxMs);
    this.connect();
  }

  _startPing() {
    this._stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send("ping");
      }
    }, config.pingIntervalMs);
  }

  _stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  _startWatchdog() {
    this._stopWatchdog();
    this.lastDataTime = Date.now();
    this.watchdogTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastDataTime;
      if (elapsed > config.watchdogTimeoutMs) {
        log.warn(TAG, `No data for ${(elapsed / 1000).toFixed(0)}s — forcing reconnect (known freeze bug)`);
        this._forceReconnect();
      }
    }, 15000);
  }

  _stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  _forceReconnect() {
    this._stopPing();
    this._stopWatchdog();
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.terminate();
      } catch {}
    }
    this.reconnectDelay = config.reconnectBaseMs;
    setTimeout(() => this.connect(), 500);
  }

  close() {
    this.intentionalClose = true;
    this._stopPing();
    this._stopWatchdog();
    if (this.ws) {
      this.ws.close();
    }
  }
}

module.exports = RtdsClient;
