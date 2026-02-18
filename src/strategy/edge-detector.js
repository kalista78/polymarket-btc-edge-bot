const config = require("../config");
const log = require("../utils/logger");

const TAG = "EDGE";

/**
 * Conservative quote-equivalent taker fee estimate per share.
 * Based on Polymarket docs: fee scales with min(price, 1-price).
 */
function calculateFee(price, feeRateBps) {
  return price * (1 - price) * feeRateBps / 10000;
}

function estimateBuyFill(asks, targetBetUsdc) {
  if (!Array.isArray(asks) || asks.length === 0 || !Number.isFinite(targetBetUsdc) || targetBetUsdc <= 0) {
    return null;
  }

  let remainingUsdc = targetBetUsdc;
  let spentUsdc = 0;
  let shares = 0;
  let worstPrice = 0;
  let totalAvailableUsdc = 0;

  for (const level of asks) {
    const price = Number(level?.price);
    const size = Number(level?.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) continue;

    const levelUsdc = price * size;
    totalAvailableUsdc += levelUsdc;
    const takeUsdc = Math.min(remainingUsdc, levelUsdc);
    if (takeUsdc <= 0) continue;

    const takeShares = takeUsdc / price;
    spentUsdc += takeUsdc;
    shares += takeShares;
    worstPrice = price;
    remainingUsdc -= takeUsdc;

    if (remainingUsdc <= 1e-8) break;
  }

  if (spentUsdc <= 0 || shares <= 0) return null;

  return {
    shares,
    spentUsdc,
    avgPrice: spentUsdc / shares,
    worstPrice,
    fillRatio: spentUsdc / targetBetUsdc,
    totalAvailableUsdc,
  };
}

function buildSide({
  side,
  fairProb,
  fairProbRaw,
  bestAsk,
  bestAskSize,
  bestBid,
  asks,
  feeRateBps,
  targetBetUsdc,
  constraints = {},
}) {
  if (!bestAsk || bestAsk <= 0 || !fairProb) return null;

  const fill = estimateBuyFill(asks, targetBetUsdc);
  if (!fill) return null;

  const shares = Math.floor(fill.shares * 10000) / 10000;
  if (shares <= 0) return null;

  const marketPrice = fill.avgPrice;
  const fee = calculateFee(marketPrice, feeRateBps);
  const slippage = config.slippageBuffer;
  const effectiveCost = marketPrice + fee + slippage;
  const netEdge = fairProb - effectiveCost;
  const edgePct = fairProb > 0 ? netEdge / fairProb : 0;
  const expectedPnl = netEdge * shares;
  const hasDepth = fill.fillRatio >= config.minBookFillRatio;
  const hasBookDepth = fill.totalAvailableUsdc >= (constraints.minBookDepthUsdc ?? config.minBookDepthUsdc);
  const spread = bestBid > 0 ? (bestAsk - bestBid) : 1;
  const maxSpread = constraints.maxSpread ?? config.maxSpread;
  const hasTightSpread = spread <= maxSpread;
  const minEntryPrice = constraints.minEntryPrice ?? config.minEntryPrice;
  const maxEntryPrice = constraints.maxEntryPrice ?? config.maxEntryPrice;
  const inPriceBand =
    marketPrice >= minEntryPrice &&
    marketPrice <= maxEntryPrice &&
    fill.worstPrice <= maxEntryPrice;
  const minNetEdge = constraints.minNetEdge ?? config.minNetEdge;
  const maxFairEntryPrice = fairProb - minNetEdge - slippage - fee;
  const orderLimitPrice = Math.min(
    maxEntryPrice,
    fill.worstPrice + config.executionPriceBuffer,
    maxFairEntryPrice
  );
  const canCrossNow = orderLimitPrice >= bestAsk;

  return {
    side,
    fairProb,
    fairProbRaw,
    marketPrice,
    quoteBestAsk: bestAsk,
    bestBid: bestBid || 0,
    marketSize: bestAskSize || 0,
    shares,
    spentUsdc: +(marketPrice * shares).toFixed(6),
    spread,
    fee,
    slippage,
    effectiveCost,
    netEdge,
    edgePct,
    expectedPnl,
    fillRatio: fill.fillRatio,
    totalBookDepthUsdc: fill.totalAvailableUsdc,
    worstFillPrice: fill.worstPrice,
    maxFairEntryPrice,
    orderLimitPrice,
    canCrossNow,
    hasDepth,
    hasBookDepth,
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
 * @param {object} constraints   - Optional threshold overrides for regime switching
 * @returns {object|null}        - { side, fairProb, marketPrice, fee, netEdge, edgePct } or null
 */
function detectEdge(
  fairValue,
  orderbook,
  feeRateBps = config.feeRateBps,
  targetBetUsdc = config.positionSizeUsdc,
  constraints = {}
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
      asks: orderbook.up.asks,
      feeRateBps,
      targetBetUsdc,
      constraints,
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
      asks: orderbook.down.asks,
      feeRateBps,
      targetBetUsdc,
      constraints,
    });
    if (down) sides.push(down);
  }

  if (sides.length > 1) {
    const snapshot = sides
      .map((s) => `${s.side}:fair=${s.fairProb.toFixed(3)} vwap=${s.marketPrice.toFixed(3)} edge=${(s.edgePct * 100).toFixed(1)}%`)
      .join(" | ");
    log.debug(TAG, `Candidates => ${snapshot}`);
  }

  // Pick the side with the largest edge percentage, subject to conservative constraints.
  const best = sides
    .filter((s) => s.edgePct >= (constraints.edgeThreshold ?? config.edgeThreshold))
    .filter((s) => s.netEdge >= (constraints.minNetEdge ?? config.minNetEdge))
    .filter((s) => s.expectedPnl >= (constraints.minExpectedPnlUsdc ?? config.minExpectedPnlUsdc))
    .filter((s) => s.hasDepth)
    .filter((s) => s.hasBookDepth)
    .filter((s) => s.hasTightSpread)
    .filter((s) => s.inPriceBand)
    .filter((s) => s.canCrossNow)
    .sort((a, b) => b.edgePct - a.edgePct)[0];

  if (!best) {
    // Log the best available even if below threshold
    const closest = sides.sort((a, b) => b.edgePct - a.edgePct)[0];
    if (closest) {
      log.debug(
        TAG,
        `No edge: ${closest.side} fair=${closest.fairProb.toFixed(3)} bid=${closest.bestBid.toFixed(3)} ask=${closest.quoteBestAsk.toFixed(3)} vwap=${closest.marketPrice.toFixed(3)} worst=${closest.worstFillPrice.toFixed(3)} fill=${(closest.fillRatio * 100).toFixed(1)}% book=$${closest.totalBookDepthUsdc.toFixed(2)} spr=${closest.spread.toFixed(3)} edge=${(closest.edgePct * 100).toFixed(1)}% net=${closest.netEdge.toFixed(3)} ev=$${closest.expectedPnl.toFixed(3)} inBand=${closest.inPriceBand}`
      );
    }
    return null;
  }

  log.info(TAG, `EDGE FOUND: ${best.side}`, {
    fairRaw: best.fairProbRaw.toFixed(3),
    fair: best.fairProb.toFixed(3),
    bid: best.bestBid.toFixed(3),
    ask: best.quoteBestAsk.toFixed(3),
    vwap: best.marketPrice.toFixed(3),
    worst: best.worstFillPrice.toFixed(3),
    fill: `${(best.fillRatio * 100).toFixed(1)}%`,
    depth: `$${best.totalBookDepthUsdc.toFixed(2)}`,
    limit: best.orderLimitPrice.toFixed(3),
    band: `${(constraints.minEntryPrice ?? config.minEntryPrice).toFixed(2)}-${(constraints.maxEntryPrice ?? config.maxEntryPrice).toFixed(2)}`,
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
