const config = require("../config");
const log = require("../utils/logger");

const TAG = "PRICE";

class PriceTracker {
  constructor() {
    // Rolling buffers of { price, timestampMs } for volatility calc
    this.binancePrices = [];
    this.chainlinkPrices = [];
    this.currentBinancePrice = null;
    this.currentChainlinkPrice = null;
    this.lastBinanceTs = 0;
    this.lastChainlinkTs = 0;

    // Start prices keyed by window timestamp (unix seconds, multiple of 300)
    this.startPrices = new Map();
    // Candle cache keyed by window timestamp -> { open, close }
    this.windowCandles = new Map();

    // Cached volatility
    this._cachedVol = null;
    this._volCacheTime = 0;
    this._volCacheWindowTs = null;
    this._lastVolDetails = null;

    // Track which windows we've already fetched
    this._fetchedWindows = new Set();
    this._fetchingWindows = new Set();
  }

  normalizeTimestamp(timestamp) {
    const n = Number(timestamp);
    if (!Number.isFinite(n) || n <= 0) return Date.now();
    // Some feeds emit unix seconds; normalize to ms.
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }

  trimPriceBuffer(buffer) {
    const cutoff = Date.now() - config.volWindowSec * 1000;
    while (buffer.length > 0 && buffer[0].timestamp < cutoff) {
      buffer.shift();
    }
  }

  pushPrice(buffer, { price, timestamp }) {
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return;
    buffer.push({ price: p, timestamp: this.normalizeTimestamp(timestamp) });
    this.trimPriceBuffer(buffer);
    this._cachedVol = null;
  }

  onBinancePrice({ price, timestamp }) {
    this.currentBinancePrice = Number(price);
    this.lastBinanceTs = this.normalizeTimestamp(timestamp);
    this.pushPrice(this.binancePrices, { price, timestamp: this.lastBinanceTs });
  }

  onChainlinkPrice({ price, timestamp }) {
    this.currentChainlinkPrice = Number(price);
    this.lastChainlinkTs = this.normalizeTimestamp(timestamp);
    this.pushPrice(this.chainlinkPrices, { price, timestamp: this.lastChainlinkTs });
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
        this.windowCandles.set(candle.time, {
          open: Number(candle.open),
          close: Number(candle.close),
        });
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
      if (this.windowCandles.size > 20) {
        const keys = [...this.windowCandles.keys()].sort((a, b) => a - b);
        for (let i = 0; i < keys.length - 20; i++) {
          this.windowCandles.delete(keys[i]);
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
        this.windowCandles.set(windowTs, {
          open: Number(match.openPrice),
          close: Number(match.closePrice),
        });
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
      this.windowCandles.set(windowTs, {
        open: Number(candle.open),
        close: Number(candle.close),
      });

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
    const source = this.getCurrentPriceSource();
    if (source === "chainlink") return this.currentChainlinkPrice;
    if (source === "binance") return this.currentBinancePrice;
    return null;
  }

  getCurrentPriceSource() {
    const chainlinkFresh = Number.isFinite(this.currentChainlinkPrice) &&
      this.lastChainlinkTs > 0 &&
      (Date.now() - this.lastChainlinkTs) <= config.priceStaleMs;
    const binanceFresh = Number.isFinite(this.currentBinancePrice) &&
      this.lastBinanceTs > 0 &&
      (Date.now() - this.lastBinanceTs) <= config.priceStaleMs;

    if (config.priceSource === "chainlink") {
      return chainlinkFresh ? "chainlink" : "none";
    }
    if (config.priceSource === "binance") {
      return binanceFresh ? "binance" : "none";
    }

    // auto mode: prefer Chainlink (Polymarket-native), fallback to Binance.
    if (chainlinkFresh) return "chainlink";
    if (binanceFresh) return "binance";
    return "none";
  }

  getChainlinkPrice() {
    return this.currentChainlinkPrice;
  }

  getStartPrice(windowTs) {
    return this.startPrices.get(windowTs) || null;
  }

  getWindowCandle(windowTs) {
    return this.windowCandles.get(windowTs) || null;
  }

  getLastCompletedRoundSigmaPerSec(currentWindowTs) {
    const prevWindowTs = currentWindowTs - config.windowDurationSec;
    const candle = this.getWindowCandle(prevWindowTs);
    if (!candle || !candle.open || !candle.close || candle.open <= 0 || candle.close <= 0) {
      return null;
    }

    const absLogMove = Math.abs(Math.log(candle.close / candle.open));
    const sigmaPerSec = absLogMove / Math.sqrt(config.windowDurationSec);
    if (!Number.isFinite(sigmaPerSec) || sigmaPerSec <= 0) return null;
    return sigmaPerSec;
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

  getVolatilitySeries() {
    if (config.priceSource === "chainlink") {
      return { source: "chainlink", prices: this.chainlinkPrices };
    }
    if (config.priceSource === "binance") {
      return { source: "binance", prices: this.binancePrices };
    }

    // auto mode: prefer Chainlink if we have enough points for realized vol.
    if (this.chainlinkPrices.length >= 5) {
      return { source: "chainlink", prices: this.chainlinkPrices };
    }
    return { source: "binance", prices: this.binancePrices };
  }

  /**
   * Calculate per-second sigma from selected signal source samples.
   */
  getVolatility(currentWindowTs = this.getCurrentWindowTs()) {
    if (
      this._cachedVol !== null &&
      this._volCacheWindowTs === currentWindowTs &&
      Date.now() - this._volCacheTime < 1000
    ) {
      return this._cachedVol;
    }

    const { source: volSource, prices } = this.getVolatilitySeries();
    let microSigma = 1.07e-4;

    if (prices.length < 10) {
      microSigma = 1.07e-4; // default ~60% annualized
    } else {
      const returns = [];
      for (let i = 1; i < prices.length; i++) {
        const dt = (prices[i].timestamp - prices[i - 1].timestamp) / 1000;
        if (dt <= 0 || dt > 60) continue;
        const logReturn = Math.log(prices[i].price / prices[i - 1].price);
        returns.push({ logReturn, dt });
      }

      if (returns.length >= 5) {
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
        microSigma = Math.sqrt(conservativeVar);
      }
    }
    microSigma = Math.max(config.minSigmaPerSec, Math.min(config.maxSigmaPerSec, microSigma));

    // Blend with the completed previous 5m candle move to reflect recent regime shifts.
    const roundSigmaRaw = this.getLastCompletedRoundSigmaPerSec(currentWindowTs);
    const roundSigma = Number.isFinite(roundSigmaRaw)
      ? Math.max(config.minSigmaPerSec, Math.min(config.maxSigmaPerSec, roundSigmaRaw))
      : null;
    const blend = Math.max(0, Math.min(1, config.roundVolBlend));

    let blendedSigma = microSigma;
    if (roundSigma !== null) {
      blendedSigma = Math.sqrt((1 - blend) * microSigma * microSigma + blend * roundSigma * roundSigma);
      const roundFloor = roundSigma * config.roundVolFloorMultiplier;
      blendedSigma = Math.max(blendedSigma, roundFloor);
    }
    const clamped = Math.max(config.minSigmaPerSec, Math.min(config.maxSigmaPerSec, blendedSigma));

    this._cachedVol = clamped;
    this._volCacheTime = Date.now();
    this._volCacheWindowTs = currentWindowTs;
    this._lastVolDetails = {
      windowTs: currentWindowTs,
      volPriceSource: volSource,
      microSigmaPerSec: microSigma,
      roundSigmaPerSec: roundSigma,
      blendedSigmaPerSec: clamped,
      roundVolBlend: blend,
    };

    return clamped;
  }

  getVolatilityDetails() {
    return this._lastVolDetails;
  }
}

module.exports = PriceTracker;
