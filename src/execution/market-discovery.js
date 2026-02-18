const config = require("../config");
const log = require("../utils/logger");

const TAG = "MARKET";

class MarketDiscovery {
  constructor() {
    // Cache: windowTs -> { slug, conditionId, upTokenId, downTokenId, ... }
    this.cache = new Map();
    this.feeCache = new Map(); // tokenId -> { feeRateBps, ts }
  }

  /**
   * Generate the slug for a given window timestamp.
   */
  slugForWindow(windowTs) {
    return `btc-updown-5m-${windowTs}`;
  }

  /**
   * Get the current window timestamp (multiple of 300).
   */
  currentWindowTs() {
    return Math.floor(Date.now() / 1000 / config.windowDurationSec) * config.windowDurationSec;
  }

  parseFeeRateBps(payload) {
    if (!payload || typeof payload !== "object") return null;

    const bpsCandidates = [
      payload.takerFeeRateBps,
      payload.taker_fee_rate_bps,
      payload.takerBaseFee,
      payload.taker_base_fee_bps,
      payload.baseRate,
      payload.base_rate_bps,
    ];

    for (const value of bpsCandidates) {
      if (Number.isFinite(value)) return Number(value);
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        return Number(value);
      }
    }

    const decimalCandidates = [payload.takerFeeRate, payload.taker_fee_rate];
    for (const value of decimalCandidates) {
      const n = Number(value);
      if (Number.isFinite(n)) return n * 10000;
    }

    return null;
  }

  classifyOutcomeLabel(label) {
    const normalized = String(label || "").trim().toLowerCase();
    if (!normalized) return null;

    const upWords = ["up", "yes", "above", "higher", "over", "long", "bull"];
    const downWords = ["down", "no", "below", "lower", "under", "short", "bear"];

    if (upWords.includes(normalized)) return "up";
    if (downWords.includes(normalized)) return "down";

    // Fallback for labels like "Will BTC close higher?" / "Bearish"
    if (upWords.some((w) => normalized.includes(w))) return "up";
    if (downWords.some((w) => normalized.includes(w))) return "down";
    return null;
  }

  async fetchFeeRateBps(tokenId) {
    if (!tokenId) return null;

    const cached = this.feeCache.get(tokenId);
    if (cached && Date.now() - cached.ts < 60 * 1000) {
      return cached.feeRateBps;
    }

    try {
      const url = `${config.clobBaseUrl}/fee-rate?token_id=${encodeURIComponent(tokenId)}`;
      const res = await fetch(url);
      if (!res.ok) return null;

      const payload = await res.json();
      const feeRateBps = this.parseFeeRateBps(payload);
      if (!Number.isFinite(feeRateBps)) return null;

      this.feeCache.set(tokenId, { feeRateBps, ts: Date.now() });
      return feeRateBps;
    } catch {
      return null;
    }
  }

  /**
   * Discover the active market for a given window.
   * Returns { upTokenId, downTokenId, conditionId, slug, feeRateBps } or null.
   */
  async discover(windowTs) {
    // Check cache
    if (this.cache.has(windowTs)) {
      return this.cache.get(windowTs);
    }

    const slug = this.slugForWindow(windowTs);
    log.info(TAG, `Discovering market: ${slug}`);

    try {
      const url = `${config.gammaBaseUrl}/events?slug=${slug}`;
      const res = await fetch(url);

      if (!res.ok) {
        log.warn(TAG, `Gamma API returned ${res.status} for ${slug}`);
        return null;
      }

      const events = await res.json();

      if (!Array.isArray(events) || events.length === 0) {
        log.debug(TAG, `No events found for ${slug}`);
        return null;
      }

      const event = events[0];
      const markets = event.markets;

      if (!markets || markets.length === 0) {
        log.warn(TAG, `No markets in event for ${slug}`);
        return null;
      }

      // These markets have a single market entry with two outcomes (Up/Down)
      // clobTokenIds and outcomes are JSON strings that need parsing
      const market = markets[0];
      const conditionId = market.conditionId;

      // Parse clobTokenIds — it's a JSON-encoded string like '["tokenA", "tokenB"]'
      let tokenIds;
      try {
        tokenIds = typeof market.clobTokenIds === "string"
          ? JSON.parse(market.clobTokenIds)
          : market.clobTokenIds;
      } catch {
        log.warn(TAG, `Failed to parse clobTokenIds for ${slug}`);
        return null;
      }

      if (!tokenIds || tokenIds.length < 2) {
        log.warn(TAG, `Not enough token IDs for ${slug}`);
        return null;
      }

      // Parse outcomes — it's a JSON-encoded string like '["Up", "Down"]'
      let outcomes;
      try {
        outcomes = typeof market.outcomes === "string"
          ? JSON.parse(market.outcomes)
          : market.outcomes || ["Up", "Down"];
      } catch {
        outcomes = ["Up", "Down"];
      }

      // Map outcomes to token IDs
      let upTokenId = null;
      let downTokenId = null;

      for (let i = 0; i < outcomes.length; i++) {
        const side = this.classifyOutcomeLabel(outcomes[i]);
        if (side === "up") {
          upTokenId = tokenIds[i];
        } else if (side === "down") {
          downTokenId = tokenIds[i];
        }
      }

      // Fallback: first = Up, second = Down
      if (!upTokenId) upTokenId = tokenIds[0];
      if (!downTokenId) downTokenId = tokenIds[1];

      // Fee rate: prefer CLOB fee endpoint, then Gamma event data, then config fallback.
      let feeRateBps = this.parseFeeRateBps({ takerBaseFee: market.takerBaseFee });
      const clobFee = await this.fetchFeeRateBps(upTokenId);
      if (Number.isFinite(clobFee)) feeRateBps = clobFee;
      if (!Number.isFinite(feeRateBps)) feeRateBps = config.feeRateBps;

      const result = {
        slug,
        windowTs,
        conditionId,
        upTokenId,
        downTokenId,
        feeRateBps,
      };

      this.cache.set(windowTs, result);

      // Clean old cache entries
      if (this.cache.size > 10) {
        const keys = [...this.cache.keys()].sort((a, b) => a - b);
        for (let i = 0; i < keys.length - 10; i++) {
          this.cache.delete(keys[i]);
        }
      }

      log.info(TAG, `Found market ${slug}`, {
        upToken: upTokenId.slice(0, 16) + "...",
        downToken: downTokenId.slice(0, 16) + "...",
        feeRateBps,
      });

      return result;
    } catch (err) {
      log.error(TAG, `Market discovery failed: ${err.message}`);
      return null;
    }
  }
}

module.exports = MarketDiscovery;
