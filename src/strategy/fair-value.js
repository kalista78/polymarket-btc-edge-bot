const config = require("../config");
const log = require("../utils/logger");

const TAG = "FAIR";

/**
 * Approximate the standard normal CDF using the error function.
 * Φ(x) = 0.5 * (1 + erf(x / sqrt(2)))
 *
 * erf approximation from Abramowitz and Stegun (max error ~1.5e-7).
 */
function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return sign * y;
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Calculate fair probability of "Up" using a geometric Brownian motion model.
 *
 * P(Up) = Φ((ln(S_t/S_0) + (mu - 0.5*sigma^2)*tau) / (sigma*sqrt(tau)))
 *
 * We use log-moneyness so volatility (estimated from log returns) and signal
 * are in compatible units.
 *
 * @param {number} currentPrice  - Current BTC price (Binance, fast signal)
 * @param {number} startPrice    - Chainlink price at window start
 * @param {number} sigmaPerSec   - Per-second volatility
 * @param {number} timeRemainSec - Seconds until window closes
 * @returns {{
 *   pUp: number,
 *   pDown: number,
 *   pUpRaw: number,
 *   z: number,
 *   sigmaPerSec: number,
 *   logMoneyness: number,
 *   diffusion: number,
 *   driftAdj: number
 * } | null}
 */
function calculateFairValue(currentPrice, startPrice, sigmaPerSec, timeRemainSec) {
  if (!currentPrice || !startPrice || !sigmaPerSec || timeRemainSec <= 0 || currentPrice <= 0 || startPrice <= 0) {
    return null;
  }

  const sigma = clamp(sigmaPerSec, config.minSigmaPerSec, config.maxSigmaPerSec);
  const diffusion = sigma * Math.sqrt(timeRemainSec);
  const logMoneyness = Math.log(currentPrice / startPrice);
  const driftAdj = (config.driftPerSec - 0.5 * sigma * sigma) * timeRemainSec;

  if (diffusion < 1e-12) {
    // Effectively no time left — price is deterministic
    const pUpRaw = logMoneyness + driftAdj >= 0 ? config.maxProbability : config.minProbability;
    return {
      pUp: pUpRaw,
      pDown: 1 - pUpRaw,
      pUpRaw,
      z: 0,
      sigmaPerSec: sigma,
      logMoneyness,
      diffusion,
      driftAdj,
    };
  }

  const z = (logMoneyness + driftAdj) / diffusion;
  const pUpRaw = normalCdf(z);
  const shrunk = 0.5 + (pUpRaw - 0.5) * config.probabilityShrink;
  const pUp = clamp(shrunk, config.minProbability, config.maxProbability);
  const pDown = 1 - pUp;

  log.debug(
    TAG,
    `ln(S/S0)=${logMoneyness.toExponential(3)} sigma=${sigma.toExponential(3)} z=${z.toFixed(3)} Praw=${pUpRaw.toFixed(4)} P=${pUp.toFixed(4)}`
  );

  return {
    pUp,
    pDown,
    pUpRaw,
    z,
    sigmaPerSec: sigma,
    logMoneyness,
    diffusion,
    driftAdj,
  };
}

module.exports = { calculateFairValue, normalCdf };
