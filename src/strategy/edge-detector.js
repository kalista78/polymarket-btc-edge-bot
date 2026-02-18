const config = require("../config");
const log = require("../utils/logger");

const TAG = "EDGE";

/**
 * Conservative quote-equivalent taker fee estimate per share.
 * Based on Polymarket docs: fee scales with min(price, 1-price).
 */
function calculateFee(price, feeRateBps) {
  return Math.min(price, 1 - price) * feeRateBps / 10000;
}

function buildSide({
  side,
  fairProb,
  fairProbRaw,
  bestAsk,
  bestAskSize,
  bestBid,
  feeRateBps,
  targetBetUsdc,
}) {
  if (!bestAsk || bestAsk <= 0 || !fairProb) return null;

  const shares = Math.floor((targetBetUsdc / bestAsk) * 100) / 100;
  if (shares <= 0) return null;

  const fee = calculateFee(bestAsk, feeRateBps);
  const slippage = config.slippageBuffer;
  const effectiveCost = bestAsk + fee + slippage;
  const netEdge = fairProb - effectiveCost;
  const edgePct = fairProb > 0 ? netEdge / fairProb : 0;
  const expectedPnl = netEdge * shares;
  const hasDepth = (bestAskSize || 0) >= shares;
  const spread = bestBid > 0 ? (bestAsk - bestBid) : 1;
  const hasTightSpread = spread <= config.maxSpread;
  const inPriceBand = bestAsk >= config.minEntryPrice && bestAsk <= config.maxEntryPrice;

  return {
    side,
    fairProb,
    fairProbRaw,
    marketPrice: bestAsk,
    bestBid: bestBid || 0,
    marketSize: bestAskSize || 0,
    shares,
    spread,
    fee,
    slippage,
    effectiveCost,
    netEdge,
    edgePct,
    expectedPnl,
    hasDepth,
    hasTightSpread,
    inPriceBand,
  };
}

/**
 * Detect if there's an exploitable edge between fair value and the orderbook.
 *
 * @param {object} fairValue     - { pUp, pDown } from fair-value engine
 * @param {object} orderbook     - { up: { bestAsk, bestAskSize }, down: { bestAsk, bestAskSize } }
 * @param {number} feeRateBps    - Fee rate in basis points
 * @param {number} targetBetUsdc - Intended notional per trade
 * @returns {object|null}        - { side, fairProb, marketPrice, fee, netEdge, edgePct } or null
 */
function detectEdge(
  fairValue,
  orderbook,
  feeRateBps = config.feeRateBps,
  targetBetUsdc = config.positionSizeUsdc
) {
  if (!fairValue || !orderbook) return null;

  const sides = [];

  // Check Up side
  if (orderbook.up && orderbook.up.bestAsk && orderbook.up.bestAsk > 0) {
    const up = buildSide({
      side: "Up",
      fairProb: fairValue.pUp,
      fairProbRaw: fairValue.pUpRaw,
      bestAsk: orderbook.up.bestAsk,
      bestAskSize: orderbook.up.bestAskSize,
      bestBid: orderbook.up.bestBid,
      feeRateBps,
      targetBetUsdc,
    });
    if (up) sides.push(up);
  }

  // Check Down side
  if (orderbook.down && orderbook.down.bestAsk && orderbook.down.bestAsk > 0) {
    const down = buildSide({
      side: "Down",
      fairProb: fairValue.pDown,
      fairProbRaw: 1 - fairValue.pUpRaw,
      bestAsk: orderbook.down.bestAsk,
      bestAskSize: orderbook.down.bestAskSize,
      bestBid: orderbook.down.bestBid,
      feeRateBps,
      targetBetUsdc,
    });
    if (down) sides.push(down);
  }

  // Pick the side with the largest edge percentage, subject to conservative constraints.
  const best = sides
    .filter((s) => s.edgePct >= config.edgeThreshold)
    .filter((s) => s.netEdge >= config.minNetEdge)
    .filter((s) => s.expectedPnl >= config.minExpectedPnlUsdc)
    .filter((s) => s.hasDepth)
    .filter((s) => s.hasTightSpread)
    .filter((s) => s.inPriceBand)
    .sort((a, b) => b.edgePct - a.edgePct)[0];

  if (!best) {
    // Log the best available even if below threshold
    const closest = sides.sort((a, b) => b.edgePct - a.edgePct)[0];
    if (closest) {
      log.debug(
        TAG,
        `No edge: ${closest.side} fair=${closest.fairProb.toFixed(3)} bid=${closest.bestBid.toFixed(3)} ask=${closest.marketPrice.toFixed(3)} spr=${closest.spread.toFixed(3)} edge=${(closest.edgePct * 100).toFixed(1)}% net=${closest.netEdge.toFixed(3)} ev=$${closest.expectedPnl.toFixed(3)} depth=${closest.marketSize.toFixed(2)} inBand=${closest.inPriceBand}`
      );
    }
    return null;
  }

  log.info(TAG, `EDGE FOUND: ${best.side}`, {
    fairRaw: best.fairProbRaw.toFixed(3),
    fair: best.fairProb.toFixed(3),
    bid: best.bestBid.toFixed(3),
    ask: best.marketPrice.toFixed(3),
    band: `${config.minEntryPrice.toFixed(2)}-${config.maxEntryPrice.toFixed(2)}`,
    spr: best.spread.toFixed(3),
    fee: best.fee.toFixed(4),
    slip: best.slippage.toFixed(4),
    netEdge: best.netEdge.toFixed(3),
    evUsd: best.expectedPnl.toFixed(3),
    edgePct: `${(best.edgePct * 100).toFixed(1)}%`,
    shares: best.shares.toFixed(2),
  });

  return best;
}

module.exports = { detectEdge, calculateFee };
