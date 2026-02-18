const config = require("../config");
const log = require("../utils/logger");

const TAG = "PRICE";

class PriceTracker {
  constructor() {
    // Rolling buffer of { price, timestamp } for volatility calc
    this.binancePrices = [];
    this.currentBinancePrice = null;
    this.currentChainlinkPrice = null;

    // Start prices keyed by window timestamp (unix seconds, multiple of 300)
    this.startPrices = new Map();

    // Cached volatility
    this._cachedVol = null;
    this._volCacheTime = 0;

    // Track which windows we've already fetched
    this._fetchedWindows = new Set();
    this._fetchingWindows = new Set();
  }

  onBinancePrice({ price, timestamp }) {
    this.currentBinancePrice = price;
    this.binancePrices.push({ price, timestamp });

    // Trim to vol window
    const cutoff = Date.now() - config.volWindowSec * 1000;
    while (this.binancePrices.length > 0 && this.binancePrices[0].timestamp < cutoff) {
      this.binancePrices.shift();
    }

    this._cachedVol = null;
  }

  onChainlinkPrice({ price, timestamp }) {
    this.currentChainlinkPrice = price;
  }

  /**
   * Fetch the official "PRICE TO BEAT" from Polymarket's API.
   * Uses chainlink-candles endpoint (reliable, includes current active window).
   */
  async fetchStartPrice(windowTs) {
    if (this.startPrices.has(windowTs)) return this.startPrices.get(windowTs);
    if (this._fetchingWindows.has(windowTs)) return null;

    this._fetchingWindows.add(windowTs);

    try {
      const res = await fetch(
        "https://polymarket.com/api/chainlink-candles?symbol=BTC&interval=5m&limit=5",
        { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } }
      );

      if (!res.ok) {
        log.warn(TAG, `chainlink-candles returned ${res.status}`);
        return null;
      }

      const data = await res.json();
      const candles = data.candles || [];

      for (const candle of candles) {
        if (!this.startPrices.has(candle.time)) {
          this.startPrices.set(candle.time, candle.open);
          this._fetchedWindows.add(candle.time);
        }
      }

      const price = this.startPrices.get(windowTs);
      if (price) {
        log.info(TAG, `Window ${windowTs} PRICE TO BEAT: $${price.toFixed(2)} (from Polymarket API)`);
      } else {
        log.debug(TAG, `Window ${windowTs} not in candles response (${candles.map((c) => c.time).join(", ")})`);
      }

      // Clean old entries
      if (this.startPrices.size > 10) {
        const keys = [...this.startPrices.keys()].sort((a, b) => a - b);
        for (let i = 0; i < keys.length - 10; i++) {
          this.startPrices.delete(keys[i]);
        }
      }

      return price || null;
    } catch (err) {
      log.error(TAG, `Failed to fetch start price: ${err.message}`);
      return null;
    } finally {
      this._fetchingWindows.delete(windowTs);
    }
  }

  /**
   * Fetch resolution data (closePrice) for a completed window.
   * Uses past-results endpoint.
   */
  async fetchResolution(windowTs) {
    try {
      const currentStart = new Date(this.getCurrentWindowTs() * 1000).toISOString();
      const res = await fetch(
        `https://polymarket.com/api/past-results?symbol=BTC&variant=fiveminute&assetType=crypto&currentEventStartTime=${encodeURIComponent(currentStart)}&count=5`,
        { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } }
      );

      if (!res.ok) return null;
      const data = await res.json();
      const results = data.data?.results || [];

      const targetStart = new Date(windowTs * 1000).toISOString();
      const match = results.find((r) => r.startTime === targetStart);

      if (match) {
        return {
          openPrice: match.openPrice,
          closePrice: match.closePrice,
          outcome: match.outcome, // "up" or "down"
        };
      }

      return null;
    } catch (err) {
      log.error(TAG, `Failed to fetch resolution: ${err.message}`);
      return null;
    }
  }

  /**
   * Fallback resolution from chainlink candles when past-results is delayed.
   * Outcome is derived from close vs open for the exact 5m window.
   */
  async fetchResolutionFromCandles(windowTs) {
    try {
      const res = await fetch(
        "https://polymarket.com/api/chainlink-candles?symbol=BTC&interval=5m&limit=100",
        { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } }
      );

      if (!res.ok) return null;
      const data = await res.json();
      const candles = data.candles || [];
      const candle = candles.find((c) => c.time === windowTs);
      if (!candle) return null;

      return {
        openPrice: candle.open,
        closePrice: candle.close,
        outcome: candle.close >= candle.open ? "up" : "down",
        source: "chainlink-candles",
      };
    } catch (err) {
      log.error(TAG, `Failed fallback candle resolution: ${err.message}`);
      return null;
    }
  }

  getCurrentPrice() {
    return this.currentBinancePrice;
  }

  getChainlinkPrice() {
    return this.currentChainlinkPrice;
  }

  getStartPrice(windowTs) {
    return this.startPrices.get(windowTs) || null;
  }

  getCurrentWindowTs() {
    return Math.floor(Date.now() / 1000 / config.windowDurationSec) * config.windowDurationSec;
  }

  getTimeRemainingMs() {
    const now = Date.now() / 1000;
    const windowTs = Math.floor(now / config.windowDurationSec) * config.windowDurationSec;
    const windowEnd = windowTs + config.windowDurationSec;
    return Math.max(0, (windowEnd - now) * 1000);
  }

  getTimeRemainingSec() {
    return this.getTimeRemainingMs() / 1000;
  }

  /**
   * Calculate per-second sigma from Binance price samples for Brownian motion model.
   */
  getVolatility() {
    if (this._cachedVol !== null && Date.now() - this._volCacheTime < 1000) {
      return this._cachedVol;
    }

    const prices = this.binancePrices;
    if (prices.length < 10) {
      return 1.07e-4; // default ~60% annualized
    }

    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      const dt = (prices[i].timestamp - prices[i - 1].timestamp) / 1000;
      if (dt <= 0 || dt > 60) continue;
      const logReturn = Math.log(prices[i].price / prices[i - 1].price);
      returns.push({ logReturn, dt });
    }

    if (returns.length < 5) {
      return Math.max(config.minSigmaPerSec, Math.min(config.maxSigmaPerSec, 1.07e-4));
    }

    // Realized variance estimator in per-second units.
    const totalTime = returns.reduce((s, r) => s + r.dt, 0);
    const sumSqReturns = returns.reduce((s, r) => s + (r.logReturn * r.logReturn), 0);
    const realizedVarPerSec = totalTime > 0 ? sumSqReturns / totalTime : 1.07e-4 * 1.07e-4;

    // EWMA to avoid under-reacting after volatility shocks.
    const lambda = 0.94;
    let ewmaVarPerSec = realizedVarPerSec;
    for (const r of returns) {
      const instVarPerSec = (r.logReturn * r.logReturn) / r.dt;
      ewmaVarPerSec = lambda * ewmaVarPerSec + (1 - lambda) * instVarPerSec;
    }

    const conservativeVar = Math.max(realizedVarPerSec, ewmaVarPerSec);
    const sigmaPerSec = Math.sqrt(conservativeVar);
    const clamped = Math.max(config.minSigmaPerSec, Math.min(config.maxSigmaPerSec, sigmaPerSec));

    this._cachedVol = clamped;
    this._volCacheTime = Date.now();

    return clamped;
  }
}

module.exports = PriceTracker;
