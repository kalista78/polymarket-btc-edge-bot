const fs = require("fs");
const path = require("path");
const config = require("./config");
// Patch global fetch + set HTTP_PROXY before any network imports
require("./utils/proxy").setupProxy();
const log = require("./utils/logger");
const stats = require("./utils/stats");
const RtdsClient = require("./feeds/rtds");
const PriceTracker = require("./feeds/price-tracker");
const { calculateFairValue } = require("./strategy/fair-value");
const { detectEdge, calculateFee } = require("./strategy/edge-detector");
const MarketDiscovery = require("./execution/market-discovery");
const { fetchBothBooks, fetchOrderbook } = require("./execution/orderbook");
const { placeOrder, getLiveCollateralUsdc } = require("./execution/order");
const { AutoClaimer } = require("./execution/claim");
const TelegramBot = require("./integrations/telegram");

const TAG = "MAIN";
const BASE_BET_SIZE = config.positionSizeUsdc;
const ARB_ALERT_COOLDOWN_MS = 45000;
const ASCII_BANNER = String.raw`
 ____       _                  _             _        _   
|  _ \ ___ | |_   _ _ __ ___  | | ___   ___| | _____| |_ 
| |_) / _ \| | | | | '_ \` _ \ | |/ _ \ / __| |/ / _ \ __|
|  __/ (_) | | |_| | | | | | || | (_) | (__|   <  __/ |_ 
|_|   \___/|_|\__, |_| |_| |_||_|\___/ \___|_|\_\___|\__|
              |___/                    BTC 5m Edge Bot
`;

// Keep paper and live run history separate.
// Use data/ subdir for Docker volume persistence.
const DATA_DIR = path.resolve(__dirname, "../data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const TRADES_FILE = path.resolve(
  DATA_DIR,
  config.paperTrade ? "paper-trades.json" : "live-trades.json"
);

function loadTrades() {
  try {
    if (fs.existsSync(TRADES_FILE)) return JSON.parse(fs.readFileSync(TRADES_FILE, "utf-8"));
  } catch {}
  return { runStart: new Date().toISOString(), trades: [], summary: {} };
}

function saveTrades(data) {
  const resolved = data.trades.filter((t) => t.resolved);
  const wins = resolved.filter((t) => t.won);
  const losses = resolved.filter((t) => !t.won);
  const totalWagered = resolved.reduce((s, t) => s + t.cost, 0);
  data.summary = {
    totalTrades: data.trades.length,
    resolved: resolved.length,
    pending: data.trades.length - resolved.length,
    wins: wins.length,
    losses: losses.length,
    winRate: resolved.length > 0 ? +(wins.length / resolved.length * 100).toFixed(1) : 0,
    totalPnl: +resolved.reduce((s, t) => s + t.pnl, 0).toFixed(2),
    totalWagered: +totalWagered.toFixed(2),
    roi: totalWagered > 0
      ? +(resolved.reduce((s, t) => s + t.pnl, 0) / totalWagered * 100).toFixed(1)
      : 0,
  };
  fs.writeFileSync(TRADES_FILE, JSON.stringify(data, null, 2));
}

// Set log level from env
if (process.env.LOG_LEVEL) log.setLevel(process.env.LOG_LEVEL);

let tradesData;
let dailyLossLockout = false;
let liveTradesSubmitted = 0;
let liveNotionalSubmitted = 0;
let tradingPaused = false;
let telegram = null;
let autoClaimer = null;
let liveCashBalanceUsdc = null;
let lastLiveBalanceFetchMs = 0;
let lastArbAlertMs = 0;
const sigmaHistory = [];

function getTodayRealizedPnl() {
  if (!tradesData || !Array.isArray(tradesData.trades)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  return tradesData.trades
    .filter((t) => t.resolved && typeof t.resolvedAt === "string" && t.resolvedAt.startsWith(today))
    .reduce((s, t) => s + (Number(t.pnl) || 0), 0);
}

function getSummarySnapshot() {
  const summary = tradesData?.summary || {};
  const allTrades = Array.isArray(tradesData?.trades) ? tradesData.trades : [];
  const upCount = allTrades.filter((t) => t.side === "Up").length;
  const downCount = allTrades.filter((t) => t.side === "Down").length;
  const openPositions = tradesData?.trades?.filter((t) => !t.resolved).length || 0;
  const realizedPnl = Number(summary.totalPnl || 0);
  const computedBalance = +(config.startingBalanceUsdc + realizedPnl).toFixed(2);
  const hasLiveCash = !config.paperTrade && Number.isFinite(liveCashBalanceUsdc);
  const totalBalance = hasLiveCash ? +liveCashBalanceUsdc.toFixed(2) : computedBalance;
  const balanceSource = hasLiveCash ? "live_cash" : "computed";
  return {
    summary,
    openPositions,
    upCount,
    downCount,
    realizedPnl,
    totalBalance,
    balanceSource,
  };
}

async function refreshLiveCashBalance(force = false) {
  if (config.paperTrade) return null;

  const now = Date.now();
  if (!force && now - lastLiveBalanceFetchMs < 15000) {
    return liveCashBalanceUsdc;
  }

  lastLiveBalanceFetchMs = now;
  const usdc = await getLiveCollateralUsdc();
  if (Number.isFinite(usdc)) {
    liveCashBalanceUsdc = +usdc.toFixed(2);
  }
  return liveCashBalanceUsdc;
}

async function notifyTelegram(text) {
  if (!telegram) return;
  await telegram.sendMessage(text);
}

function formatStatusMessage(currentPrice, currentPriceSource = config.priceSource) {
  const { summary, openPositions, upCount, downCount, realizedPnl, totalBalance, balanceSource } = getSummarySnapshot();
  const mode = config.paperTrade ? "PAPER" : "LIVE";
  const state = tradingPaused ? "PAUSED" : "RUNNING";
  const price = Number.isFinite(currentPrice) ? `$${currentPrice.toFixed(2)}` : "N/A";
  const sourceLabel = String(currentPriceSource || "n/a").toUpperCase();
  const balanceLabel = config.paperTrade ? "Total balance" : "Cash balance";
  const balanceSuffix = !config.paperTrade && balanceSource === "computed" ? " (est.)" : "";
  return [
    `Polymarket Bot Status`,
    `Mode: ${mode} (${state})`,
    `BTC (${sourceLabel}): ${price}`,
    `Resolved: ${summary.resolved || 0}/${summary.totalTrades || 0}`,
    `Side mix: Up ${upCount} / Down ${downCount}`,
    `Open positions: ${openPositions}`,
    `Realized PnL: $${realizedPnl.toFixed(2)}`,
    `${balanceLabel}: $${totalBalance.toFixed(2)}${balanceSuffix}`,
    `Win rate: ${(summary.winRate || 0).toFixed(1)}%`,
    `ROI: ${(summary.roi || 0).toFixed(1)}%`,
  ].join("\n");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function applyChainlinkConfirmation(fairValue, { currentPrice, startPrice, chainlinkPrice, currentPriceSource }) {
  if (!fairValue) return null;

  const result = {
    ...fairValue,
    pUpModel: fairValue.pUp,
    pDownModel: fairValue.pDown,
    pUpAdjusted: fairValue.pUp,
    pDownAdjusted: fairValue.pDown,
    chainlinkSignal: "neutral",
    chainlinkMoveBps: null,
    chainlinkPrice: Number.isFinite(chainlinkPrice) ? chainlinkPrice : null,
  };

  // If model input is already Chainlink/Polymarket-native, do not self-confirm/boost it.
  if (currentPriceSource === "chainlink" || currentPriceSource === "candle") {
    if (Number.isFinite(currentPrice) && Number.isFinite(startPrice) && startPrice > 0) {
      result.chainlinkMoveBps = +(((currentPrice - startPrice) / startPrice) * 10000).toFixed(2);
    }
    result.chainlinkSignal = "source_chainlink";
    return result;
  }

  if (
    !config.chainlinkConfirmEnabled ||
    !Number.isFinite(chainlinkPrice) ||
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(startPrice) ||
    startPrice <= 0
  ) {
    return result;
  }

  const binanceMove = currentPrice - startPrice;
  const chainlinkMove = chainlinkPrice - startPrice;
  const chainlinkMoveBps = (chainlinkMove / startPrice) * 10000;
  result.chainlinkMoveBps = +chainlinkMoveBps.toFixed(2);

  if (Math.abs(chainlinkMoveBps) < config.chainlinkNeutralMoveBps) {
    return result;
  }

  const binSign = Math.sign(binanceMove);
  const clSign = Math.sign(chainlinkMove);

  let adjustedPUp = fairValue.pUp;
  if (binSign !== 0 && clSign !== 0 && binSign === clSign) {
    // Confirming feed: nudge probability slightly toward the observed direction.
    adjustedPUp += binSign > 0 ? config.chainlinkConfirmBoost : -config.chainlinkConfirmBoost;
    result.chainlinkSignal = "agree";
  } else if (binSign !== 0 && clSign !== 0 && binSign !== clSign) {
    // Conflicting feed: shrink confidence toward 50/50.
    adjustedPUp = 0.5 + (adjustedPUp - 0.5) * (1 - config.chainlinkConflictPull);
    result.chainlinkSignal = "disagree";
  } else {
    result.chainlinkSignal = "neutral";
  }

  adjustedPUp = clamp(adjustedPUp, config.minProbability, config.maxProbability);
  result.pUp = adjustedPUp;
  result.pDown = 1 - adjustedPUp;
  result.pUpAdjusted = result.pUp;
  result.pDownAdjusted = result.pDown;
  return result;
}

function buildTradingProfile({ timeRemaining, zScore, volRegime }) {
  const lateWindowMode =
    config.lateWindowEnabled &&
    timeRemaining <= config.lateWindowMaxTimeSec &&
    timeRemaining >= config.lateWindowMinTimeSec &&
    Math.abs(zScore) >= config.lateWindowMinZScore;

  let edgeThreshold = lateWindowMode ? config.lateWindowEdgeThreshold : config.edgeThreshold;
  if (volRegime === "high_vol") edgeThreshold *= config.volHighEdgeFactor;
  if (volRegime === "low_vol") edgeThreshold *= config.volLowEdgeFactor;
  edgeThreshold = clamp(edgeThreshold, 0, 0.99);

  return {
    lateWindowMode,
    volRegime,
    label: lateWindowMode ? "late_window" : "normal",
    minTimeRemainingSec: lateWindowMode ? config.lateWindowMinTimeSec : config.minTimeRemainingSec,
    edgeThreshold,
    minNetEdge: lateWindowMode ? config.lateWindowMinNetEdge : config.minNetEdge,
    minExpectedPnlUsdc: config.minExpectedPnlUsdc,
    minEntryPrice: config.minEntryPrice,
    maxEntryPrice: lateWindowMode
      ? Math.max(config.maxEntryPrice, config.lateWindowMaxEntryPrice)
      : config.maxEntryPrice,
    maxSpread: config.maxSpread,
    minBookDepthUsdc: config.minBookDepthUsdc,
  };
}

function computeAdaptiveBetSize({ edge, profile, chainlinkSignal }) {
  if (!config.adaptiveSizingEnabled) return BASE_BET_SIZE;

  let bet = BASE_BET_SIZE;
  const edgeExcess = Math.max(0, edge.edgePct - profile.edgeThreshold);
  bet *= 1 + edgeExcess * config.adaptiveEdgeMultiplier;

  const conviction = Math.max(0, Math.abs(edge.fairProb - 0.5) - 0.05);
  bet *= 1 + conviction * config.adaptiveConfidenceMultiplier;

  if (profile.lateWindowMode) {
    bet *= config.lateWindowSizeMultiplier;
  }

  if (chainlinkSignal === "agree") {
    bet *= config.chainlinkAgreeSizeMultiplier;
  } else if (chainlinkSignal === "disagree") {
    bet *= config.chainlinkDisagreeSizeMultiplier;
  }

  bet = clamp(bet, config.minPositionSizeUsdc, config.maxPositionSizeUsdc);
  return round2(bet);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function classifyVolRegime(sigma) {
  if (!config.volRegimeEnabled || !Number.isFinite(sigma)) {
    return { regime: "normal", medianSigma: null };
  }

  sigmaHistory.push(sigma);
  if (sigmaHistory.length > config.volRegimeLookback) sigmaHistory.shift();
  if (sigmaHistory.length < 20) return { regime: "normal", medianSigma: null };

  const medianSigma = median(sigmaHistory);
  if (!Number.isFinite(medianSigma) || medianSigma <= 0) {
    return { regime: "normal", medianSigma: null };
  }
  if (sigma >= medianSigma * config.volHighMultiplier) {
    return { regime: "high_vol", medianSigma };
  }
  if (sigma <= medianSigma * config.volLowMultiplier) {
    return { regime: "low_vol", medianSigma };
  }
  return { regime: "normal", medianSigma };
}

function detectCombinedArbOpportunity(books, feeRateBps) {
  if (!config.combinedArbEnabled) return null;
  if (!books?.up?.bestAsk || !books?.down?.bestAsk) return null;

  const upAsk = Number(books.up.bestAsk);
  const downAsk = Number(books.down.bestAsk);
  if (!Number.isFinite(upAsk) || !Number.isFinite(downAsk) || upAsk <= 0 || downAsk <= 0) return null;

  const feeUp = calculateFee(upAsk, feeRateBps);
  const feeDown = calculateFee(downAsk, feeRateBps);
  const perShareCost = upAsk + downAsk + feeUp + feeDown + (2 * config.slippageBuffer);
  const netPerShare = 1 - perShareCost;
  if (netPerShare < config.combinedArbMinNetPerShare) return null;

  const upDepth = Number(books.up.bestAskSize || 0);
  const downDepth = Number(books.down.bestAskSize || 0);
  const maxSharesByDepth = Math.min(upDepth, downDepth);
  const maxSharesByBudget = config.combinedArbMaxUsdc / Math.max(1e-9, upAsk + downAsk);
  const shares = Math.floor(Math.min(maxSharesByDepth, maxSharesByBudget) * 10000) / 10000;
  if (!Number.isFinite(shares) || shares <= 0) return null;

  const grossCost = shares * (upAsk + downAsk);
  const expectedNet = shares * netPerShare;
  return {
    upAsk,
    downAsk,
    feeUp,
    feeDown,
    perShareCost,
    netPerShare,
    shares,
    grossCost,
    expectedNet,
  };
}

function summarizeRoundRisk(trades, pendingTrade = null) {
  const all = [...(Array.isArray(trades) ? trades : [])];
  if (pendingTrade) all.push(pendingTrade);

  let upCost = 0;
  let downCost = 0;
  let upShares = 0;
  let downShares = 0;
  let pnlIfUp = 0;
  let pnlIfDown = 0;

  for (const t of all) {
    const side = t?.side;
    const shares = Number(t?.shares);
    const cost = Number(t?.cost);
    if (!Number.isFinite(shares) || !Number.isFinite(cost) || shares <= 0 || cost <= 0) continue;

    if (side === "Up") {
      upCost += cost;
      upShares += shares;
      pnlIfUp += shares - cost;
      pnlIfDown -= cost;
    } else if (side === "Down") {
      downCost += cost;
      downShares += shares;
      pnlIfDown += shares - cost;
      pnlIfUp -= cost;
    }
  }

  const worstCasePnl = Math.min(pnlIfUp, pnlIfDown);
  const worstCaseLoss = Math.max(0, -worstCasePnl);
  return {
    upCost,
    downCost,
    upShares,
    downShares,
    pnlIfUp,
    pnlIfDown,
    worstCasePnl,
    worstCaseLoss,
  };
}

async function maybeTakeProfitPositions({ currentPrice }) {
  if (!config.takeProfitEnabled) return;

  const openTrades = tradesData.trades.filter((t) => !t.resolved);
  if (openTrades.length === 0) return;

  for (const trade of openTrades) {
    const nowMs = Date.now();
    const lastAttemptMs = Number(trade.lastTakeProfitAttemptMs || 0);
    if (Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < 5000) continue;

    const shares = Number(trade.shares);
    const cost = Number(trade.cost);
    if (!Number.isFinite(shares) || !Number.isFinite(cost) || shares <= 0 || cost <= 0) continue;

    const book = await fetchOrderbook(trade.tokenId);
    const bestBid = Number(book?.bestBid || 0);
    if (!Number.isFinite(bestBid) || bestBid <= 0) continue;

    const feeRateBps = Number.isFinite(Number(trade.feeRateBps))
      ? Number(trade.feeRateBps)
      : config.feeRateBps;
    const estFee = calculateFee(bestBid, feeRateBps);
    const estNetPerShare = Math.max(0, bestBid - estFee - config.slippageBuffer);
    const estNetProceeds = estNetPerShare * shares;
    const estPnl = estNetProceeds - cost;
    const estRoi = estPnl / cost;
    if (estRoi < config.takeProfitRoi) continue;

    trade.lastTakeProfitAttemptMs = nowMs;

    log.info(
      TAG,
      `Take-profit trigger: ${trade.side} window=${trade.windowTs} estRoi=${(estRoi * 100).toFixed(1)}% bid=${bestBid.toFixed(3)}`
    );

    const exitResult = await placeOrder({
      tokenId: trade.tokenId,
      price: bestBid,
      maxPrice: bestBid,
      size: shares,
      usdcAmount: shares,
      side: trade.side,
      orderSide: "SELL",
      orderTypeOverride: "FAK",
    });

    if (!exitResult || exitResult.skipped) {
      trade.lastTakeProfitError = exitResult?.reason || "unknown";
      saveTrades(tradesData);
      log.warn(
        TAG,
        `Take-profit exit skipped (${trade.side} window=${trade.windowTs}): ${exitResult?.reason || "unknown"}`
      );
      continue;
    }

    const soldShares = Number(exitResult.filledShares || 0);
    const soldPrice = Number(exitResult.filledPrice || bestBid);
    const soldUsdc = Number(exitResult.filledUsdc || (soldShares * soldPrice));
    if (!Number.isFinite(soldShares) || soldShares <= 0 || !Number.isFinite(soldPrice) || soldPrice <= 0) {
      continue;
    }

    const soldRatio = Math.max(0, Math.min(1, soldShares / shares));
    const soldFee = calculateFee(soldPrice, feeRateBps);
    const soldNetPerShare = Math.max(0, soldPrice - soldFee - config.slippageBuffer);
    const soldNetProceeds = soldNetPerShare * soldShares;
    const costBasisSold = cost * soldRatio;
    const realizedPnl = +(soldNetProceeds - costBasisSold).toFixed(4);
    const realizedRoi = costBasisSold > 0 ? realizedPnl / costBasisSold : 0;

    if (soldRatio < 0.999) {
      // Defensive fallback in case exchange reports a partial despite FOK.
      trade.shares = +Math.max(0, shares - soldShares).toFixed(4);
      trade.cost = +Math.max(0, cost - costBasisSold).toFixed(4);
      trade.partialRealizedPnl = +((Number(trade.partialRealizedPnl || 0) + realizedPnl).toFixed(4));
      trade.lastTakeProfitAt = new Date().toISOString();
      trade.lastTakeProfitError = null;
      saveTrades(tradesData);
      log.warn(
        TAG,
        `Take-profit partial fill (${trade.side}): sold=${soldShares.toFixed(4)}/${shares.toFixed(4)} pnl=$${realizedPnl.toFixed(2)}`
      );
      continue;
    }

    trade.resolved = true;
    trade.resolvedAt = new Date().toISOString();
    trade.won = realizedPnl >= 0;
    trade.closedEarly = true;
    trade.exitReason = "take_profit";
    trade.exitOrderId = exitResult.orderId || null;
    trade.exitOrderStatus = exitResult.orderStatus || null;
    trade.exitTokenPrice = +soldPrice.toFixed(4);
    trade.exitBestBid = +bestBid.toFixed(4);
    trade.exitFee = +soldFee.toFixed(4);
    trade.exitSlippage = +config.slippageBuffer.toFixed(4);
    trade.exitNetProceeds = +soldNetProceeds.toFixed(4);
    trade.exitRoiPct = +(realizedRoi * 100).toFixed(2);
    trade.lastTakeProfitError = null;
    trade.endPrice = +currentPrice.toFixed(2);
    trade.pnl = realizedPnl;

    stats.resolveTrade(trade.windowTs, realizedPnl >= 0);
    saveTrades(tradesData);

    log.trade(TAG, `TAKE PROFIT EXIT: ${trade.side} @ ${soldPrice.toFixed(3)} -> pnl $${realizedPnl.toFixed(2)}`, {
      roiPct: `${(realizedRoi * 100).toFixed(1)}%`,
      bid: bestBid.toFixed(3),
      fee: soldFee.toFixed(4),
      netProceeds: `$${soldNetProceeds.toFixed(2)}`,
      orderId: trade.exitOrderId,
      window: trade.windowTs,
    });

    if (config.telegramNotifyResolutions) {
      await refreshLiveCashBalance(false).catch(() => {});
      const { totalBalance, realizedPnl: totalRealizedPnl, summary } = getSummarySnapshot();
      const balanceLabel = config.paperTrade ? "Total balance" : "Cash balance";
      notifyTelegram(
        [
          `TAKE PROFIT EXIT (${config.paperTrade ? "PAPER" : "LIVE"})`,
          `${trade.side} sold @ ${soldPrice.toFixed(3)} | ROI ${trade.exitRoiPct.toFixed(1)}% | window ${trade.windowTs}`,
          `Realized on trade: $${trade.pnl.toFixed(2)} | Trigger: >= ${(config.takeProfitRoi * 100).toFixed(0)}%`,
          `Resolved: ${summary.resolved || 0}/${summary.totalTrades || 0}`,
          `Realized PnL: $${totalRealizedPnl.toFixed(2)} | ${balanceLabel}: $${totalBalance.toFixed(2)}`,
        ].join("\n")
      ).catch((err) => log.warn(TAG, `Telegram take-profit notify failed: ${err.message}`));
    }
  }
}

async function main() {
  console.log(ASCII_BANNER);
  log.info(TAG, "=== Polymarket BTC 5-Min Mispricing Bot ===");
  log.info(TAG, `Mode: ${config.paperTrade ? "PAPER TRADING" : "LIVE TRADING"}`);
  log.info(TAG, `Edge threshold: ${(config.edgeThreshold * 100).toFixed(0)}% + min net edge ${config.minNetEdge.toFixed(3)}`);
  log.info(TAG, `Bet size: base $${BASE_BET_SIZE.toFixed(2)} | adaptive ${config.adaptiveSizingEnabled ? "ON" : "OFF"} (${config.minPositionSizeUsdc}-${config.maxPositionSizeUsdc})`);
  log.info(TAG, `Same-window re-entry min price delta: $${config.sameWindowMinPriceDelta.toFixed(2)}`);
  log.info(TAG, `Late-window mode: ${config.lateWindowEnabled ? "ON" : "OFF"} (${config.lateWindowMinTimeSec}-${config.lateWindowMaxTimeSec}s, z>=${config.lateWindowMinZScore})`);
  const priceSourceLabel = config.priceSource === "candle"
    ? "CANDLE (Polymarket API close = resolution price)"
    : `${config.priceSource.toUpperCase()} (signal + volatility)`;
  log.info(TAG, `Price source: ${priceSourceLabel}`);
  log.info(TAG, `Chainlink confirm: ${config.chainlinkConfirmEnabled ? "ON" : "OFF"}`);
  log.info(TAG, `Vol regime: ${config.volRegimeEnabled ? "ON" : "OFF"} (high>${config.volHighMultiplier}x, low<${config.volLowMultiplier}x median sigma)`);
  log.info(TAG, `Execution: ${config.executionOrderType} + repriceSteps=${config.executionMaxRepriceSteps} step=${config.executionRepriceStep.toFixed(3)}`);
  log.info(TAG, `Vol blend: micro + last5m(alpha=${config.roundVolBlend.toFixed(2)} floorMult=${config.roundVolFloorMultiplier.toFixed(2)})`);
  log.info(TAG, `Entry band: ${config.minEntryPrice.toFixed(2)} - ${config.maxEntryPrice.toFixed(2)}`);
  log.info(TAG, `Take-profit: ${config.takeProfitEnabled ? "ON" : "OFF"} (roi >= ${(config.takeProfitRoi * 100).toFixed(0)}%)`);
  const openPosLimitLabel = config.maxConcurrentPositions > 0 ? `${config.maxConcurrentPositions}` : "unlimited";
  log.info(
    TAG,
    `Risk: max ${openPosLimitLabel} open / max daily loss $${config.maxDailyLossUsdc} / max round loss $${config.maxRoundLossUsdc}`
  );
  if (!config.paperTrade) {
    log.warn(
      TAG,
      `Live safeguards: ENABLE_LIVE_ORDERS=${config.enableLiveOrders} maxTrades=${config.liveMaxTradesPerRun} maxNotional=$${config.liveMaxNotionalUsdc}`
    );
  }

  config.validate();
  tradesData = loadTrades();
  tradesData.runStart = new Date().toISOString();
  saveTrades(tradesData);

  const rtds = new RtdsClient();
  const priceTracker = new PriceTracker();
  const marketDiscovery = new MarketDiscovery();

  rtds.on("binance-price", (data) => priceTracker.onBinancePrice(data));
  rtds.on("chainlink-price", (data) => priceTracker.onChainlinkPrice(data));

  let lastWindowTs = null;
  let edgeCheckInterval = null;
  let windowCheckInterval = null;
  let shuttingDown = false;

  const shutdown = async (source = "signal") => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info(TAG, `Shutting down... source=${source}`);
    if (edgeCheckInterval) clearInterval(edgeCheckInterval);
    if (windowCheckInterval) clearInterval(windowCheckInterval);
    if (telegram) telegram.stopPolling();
    if (autoClaimer) autoClaimer.stop();
    priceTracker.stopCandlePolling();
    rtds.close();
    saveTrades(tradesData);

    log.info(TAG, `Saved ${tradesData.trades.length} trades to ${path.basename(TRADES_FILE)}`);
    if (!config.paperTrade) {
      log.info(
        TAG,
        `Live order usage: ${liveTradesSubmitted}/${config.liveMaxTradesPerRun} trades, $${liveNotionalSubmitted.toFixed(2)}/$${config.liveMaxNotionalUsdc} notional`
      );
    }
    log.info(TAG, `Summary: ${JSON.stringify(tradesData.summary)}`);

    await refreshLiveCashBalance(true).catch(() => {});
    await notifyTelegram(
      `Bot stopped (${source}).\n${formatStatusMessage(priceTracker.getCurrentPrice(), priceTracker.getCurrentPriceSource())}`
    );
    process.exit(0);
  };

  if (config.telegramBotToken) {
    telegram = new TelegramBot({
      token: config.telegramBotToken,
      chatId: config.telegramChatId,
      allowFirstChat: config.telegramAllowFirstChat,
      pollIntervalMs: config.telegramPollIntervalMs,
    });

    await telegram.startPolling(async ({ command }) => {
      if (command === "/help") {
        await notifyTelegram(
          "Commands:\n/status - current status\n/stop - pause new entries\n/resume - resume entries\n/start - alias of /resume\n/balance - PnL and balance\n/claim - run claim scan now"
        );
        return;
      }

      if (command === "/status" || command === "/balance") {
        await refreshLiveCashBalance(true).catch(() => {});
        await notifyTelegram(formatStatusMessage(priceTracker.getCurrentPrice(), priceTracker.getCurrentPriceSource()));
        return;
      }

      if (command === "/stop" || command === "/pause") {
        tradingPaused = true;
        await refreshLiveCashBalance(true).catch(() => {});
        await notifyTelegram(
          `Trading paused.\n${formatStatusMessage(priceTracker.getCurrentPrice(), priceTracker.getCurrentPriceSource())}`
        );
        return;
      }

      if (command === "/resume" || command === "/start") {
        tradingPaused = false;
        await refreshLiveCashBalance(true).catch(() => {});
        await notifyTelegram(
          `Trading resumed.\n${formatStatusMessage(priceTracker.getCurrentPrice(), priceTracker.getCurrentPriceSource())}`
        );
        return;
      }

      if (command === "/claim") {
        if (!autoClaimer) {
          await notifyTelegram("Auto-claim is disabled. Set AUTO_CLAIM_ENABLED=true (live mode).");
          return;
        }
        const result = await autoClaimer.runOnce(true);
        if (!result?.message) {
          const fallback = result?.ok
            ? `Claim scan finished. Claimed: ${result.claimed || 0}`
            : `Claim scan failed: ${result?.error || "unknown error"}`;
          await notifyTelegram(fallback);
        }
        return;
      }
    });

    log.info(TAG, "Telegram integration enabled");
  } else {
    log.info(TAG, "Telegram integration disabled");
  }

  if (!config.paperTrade && config.autoClaimEnabled) {
    autoClaimer = new AutoClaimer({
      onClaim: async (msg) => {
        if (!config.telegramNotifyClaims) return;
        await notifyTelegram(msg);
      },
    });
    autoClaimer.start();
    log.info(TAG, `Auto-claim enabled (interval ${config.autoClaimIntervalMs}ms)`);
  }

  rtds.connect();

  // Start candle polling (Polymarket's own chainlink-candles = resolution source of truth)
  if (config.priceSource === "candle" || config.priceSource === "auto") {
    priceTracker.startCandlePolling();
  }

  log.info(TAG, "Waiting for price data...");
  await new Promise((resolve) => {
    const check = () => {
      if (priceTracker.getCurrentPrice()) resolve();
      else setTimeout(check, 500);
    };
    check();
  });
  log.info(
    TAG,
    `First price received (${priceTracker.getCurrentPriceSource().toUpperCase()}): $${priceTracker.getCurrentPrice().toFixed(2)}`
  );

  // Fetch start price for the current window immediately
  const windowNow = priceTracker.getCurrentWindowTs();
  await priceTracker.fetchStartPrice(windowNow);
  log.info(TAG, "Starting main loop...");

  edgeCheckInterval = setInterval(async () => {
    try {
      await tick(priceTracker, marketDiscovery);
    } catch (err) {
      log.error(TAG, `Tick error: ${err.message}`);
    }
  }, config.edgeCheckIntervalMs);

  // Window transition check (every 1s) — use sync guard to prevent duplicate fires
  let transitionInProgress = false;
  windowCheckInterval = setInterval(async () => {
    const currentWindowTs = priceTracker.getCurrentWindowTs();
    if (lastWindowTs !== null && currentWindowTs !== lastWindowTs && !transitionInProgress) {
      transitionInProgress = true;
      const prevWindow = lastWindowTs;
      lastWindowTs = currentWindowTs; // update immediately to prevent re-entry
      try {
        // New window — fetch its start price from Polymarket API
        await priceTracker.fetchStartPrice(currentWindowTs);
        // Resolve the previous window
        await onWindowTransition(prevWindow, currentWindowTs, priceTracker);
      } finally {
        transitionInProgress = false;
      }
    } else {
      lastWindowTs = currentWindowTs;
    }
  }, 1000);

  await refreshLiveCashBalance(true).catch(() => {});
  await notifyTelegram(
    `Bot started.\n${formatStatusMessage(priceTracker.getCurrentPrice(), priceTracker.getCurrentPriceSource())}`
  );

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((err) => log.error(TAG, `Shutdown error: ${err.message}`));
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((err) => log.error(TAG, `Shutdown error: ${err.message}`));
  });
}

let lastTickLog = 0;
async function tick(priceTracker, marketDiscovery) {
  const currentPrice = priceTracker.getCurrentPrice();
  const currentPriceSource = priceTracker.getCurrentPriceSource();
  if (!currentPrice) return;

  const windowTs = priceTracker.getCurrentWindowTs();
  const timeRemaining = priceTracker.getTimeRemainingSec();

  // Fetch start price if we don't have it yet
  let startPrice = priceTracker.getStartPrice(windowTs);
  if (!startPrice) {
    startPrice = await priceTracker.fetchStartPrice(windowTs);
  }

  // Periodic status log every 30s
  const now = Date.now();
  if (now - lastTickLog > 30000) {
    lastTickLog = now;
    log.info(
      TAG,
      `Status: BTC(${currentPriceSource.toUpperCase()})=$${currentPrice.toFixed(2)} window=${windowTs} timeLeft=${timeRemaining.toFixed(0)}s priceToBeat=${startPrice ? "$" + startPrice.toFixed(2) : "N/A"}`
    );
    refreshLiveCashBalance(false).catch((err) => log.warn(TAG, `Live balance refresh failed: ${err.message}`));
  }

  await maybeTakeProfitPositions({ currentPrice });

  if (tradingPaused) return;

  const todayPnl = getTodayRealizedPnl();
  if (todayPnl <= -config.maxDailyLossUsdc) {
    if (!dailyLossLockout) {
      dailyLossLockout = true;
      log.warn(TAG, `Daily loss cap reached ($${todayPnl.toFixed(2)} <= -$${config.maxDailyLossUsdc}). Trading paused for today.`);
    }
    return;
  }
  dailyLossLockout = false;

  if (!startPrice) return;

  // Hard floor before any calculation (allows late-window mode if enabled).
  const hardMinTimeRemaining = config.lateWindowEnabled
    ? Math.min(config.minTimeRemainingSec, config.lateWindowMinTimeSec)
    : config.minTimeRemainingSec;
  if (timeRemaining < hardMinTimeRemaining) return;

  const sigma = priceTracker.getVolatility(windowTs);
  const volDetails = priceTracker.getVolatilityDetails();
  const volRegimeInfo = classifyVolRegime(sigma);
  const fairValueModel = calculateFairValue(currentPrice, startPrice, sigma, timeRemaining);
  if (!fairValueModel) return;

  const fairValue = applyChainlinkConfirmation(fairValueModel, {
    currentPrice,
    startPrice,
    chainlinkPrice: priceTracker.getChainlinkPrice(),
    currentPriceSource,
  });
  const profile = buildTradingProfile({
    timeRemaining,
    zScore: fairValueModel.z,
    volRegime: volRegimeInfo.regime,
  });

  // Normal mode respects MIN_TIME_REMAINING_SEC; late-window can still run if highly confident.
  if (!profile.lateWindowMode && timeRemaining < config.minTimeRemainingSec) return;

  const market = await marketDiscovery.discover(windowTs);
  if (!market) return;

  const books = await fetchBothBooks(market.upTokenId, market.downTokenId);
  if (!books) return;

  const openPositions = tradesData.trades.filter((t) => !t.resolved).length;
  if (config.maxConcurrentPositions > 0 && openPositions >= config.maxConcurrentPositions) return;

  const arb = detectCombinedArbOpportunity(books, market.feeRateBps);
  if (arb && Date.now() - lastArbAlertMs > ARB_ALERT_COOLDOWN_MS) {
    lastArbAlertMs = Date.now();
    const arbMsg = `COMBINED ARB CANDIDATE: upAsk=${arb.upAsk.toFixed(3)} downAsk=${arb.downAsk.toFixed(3)} net/share=${(arb.netPerShare * 100).toFixed(2)}% shares=${arb.shares.toFixed(2)} estNet=$${arb.expectedNet.toFixed(3)}`;
    log.trade(TAG, arbMsg, {
      grossCost: `$${arb.grossCost.toFixed(3)}`,
      feeUp: arb.feeUp.toFixed(4),
      feeDown: arb.feeDown.toFixed(4),
      executeFlag: config.combinedArbExecute,
    });
    if (config.telegramNotifyEntries) {
      notifyTelegram(
        [
          "COMBINED ARB CANDIDATE",
          `Up ask ${arb.upAsk.toFixed(3)} + Down ask ${arb.downAsk.toFixed(3)}`,
          `Net per share: ${(arb.netPerShare * 100).toFixed(2)}% | shares ${arb.shares.toFixed(2)}`,
          `Expected net: $${arb.expectedNet.toFixed(3)} (alert-only)`,
        ].join("\n")
      ).catch((err) => log.warn(TAG, `Telegram arb notify failed: ${err.message}`));
    }
  }

  let targetBetUsdc = BASE_BET_SIZE;
  let edge = detectEdge(fairValue, books, market.feeRateBps, targetBetUsdc, profile);
  if (!edge) return;

  targetBetUsdc = computeAdaptiveBetSize({
    edge,
    profile,
    chainlinkSignal: fairValue.chainlinkSignal,
  });

  if (Math.abs(targetBetUsdc - BASE_BET_SIZE) >= 0.01) {
    edge = detectEdge(fairValue, books, market.feeRateBps, targetBetUsdc, profile);
  }
  if (!edge) return;

  // Allow opposite-side entries (natural hedge). Guard loops per-side only.
  const windowTrades = tradesData.trades.filter((t) => t.windowTs === windowTs && !t.resolved);
  const sameSideTrades = windowTrades.filter((t) => t.side === edge.side);
  const lastSameSideTrade = sameSideTrades.length > 0 ? sameSideTrades[sameSideTrades.length - 1] : null;
  if (lastSameSideTrade) {
    const delta = Math.abs(edge.marketPrice - lastSameSideTrade.marketPrice);
    if (delta < config.sameWindowMinPriceDelta) {
      log.debug(
        TAG,
        `Skip same-side re-entry: ${edge.side} delta ${delta.toFixed(3)} < ${config.sameWindowMinPriceDelta.toFixed(3)} (last=${lastSameSideTrade.marketPrice.toFixed(3)} now=${edge.marketPrice.toFixed(3)})`
      );
      return;
    }
  }

  // Round-level risk cap: allow gross exposure to grow only when hedged enough
  // that worst-case loss for this window stays within MAX_ROUND_LOSS_USDC.
  const projectedPrice = Math.max(edge.orderLimitPrice || edge.marketPrice || 0, 1e-9);
  const projectedShares = Math.floor((targetBetUsdc / projectedPrice) * 10000) / 10000;
  if (!Number.isFinite(projectedShares) || projectedShares <= 0) {
    return;
  }
  const projectedTrade = {
    side: edge.side,
    shares: projectedShares,
    cost: targetBetUsdc,
  };
  const projectedRoundRisk = summarizeRoundRisk(windowTrades, projectedTrade);
  if (projectedRoundRisk.worstCaseLoss > config.maxRoundLossUsdc + 1e-9) {
    log.info(
      TAG,
      `Skip trade by round risk: projected worst loss $${projectedRoundRisk.worstCaseLoss.toFixed(2)} > cap $${config.maxRoundLossUsdc.toFixed(2)} (${edge.side} @ ${edge.marketPrice.toFixed(3)} limit=${edge.orderLimitPrice.toFixed(3)} bet=$${targetBetUsdc.toFixed(2)})`
    );
    return;
  }

  // Edge found — optionally place live order, then record trade.
  const tokenId = edge.side === "Up" ? market.upTokenId : market.downTokenId;
  const shares = edge.shares;

  let orderResult = { paper: true };

  if (!config.paperTrade) {
    if (liveTradesSubmitted >= config.liveMaxTradesPerRun) {
      return;
    }

    const projectedNotional = liveNotionalSubmitted + targetBetUsdc;
    if (projectedNotional > config.liveMaxNotionalUsdc) {
      return;
    }

    orderResult = await placeOrder({
      tokenId,
      price: edge.quoteBestAsk,
      maxPrice: edge.orderLimitPrice,
      size: shares,
      usdcAmount: targetBetUsdc,
      side: edge.side,
    });

    if (!orderResult || orderResult.skipped) {
      if (orderResult?.reason === "order_rejected" || orderResult?.reason === "order_unaccepted") {
        const rejectMsg = orderResult?.data?.error || orderResult?.data?.status || orderResult?.reason;
        log.warn(TAG, `Live order rejected/unaccepted: ${rejectMsg}`);
        notifyTelegram(
          [
            `ORDER REJECTED (LIVE)`,
            `${edge.side} @ ${edge.marketPrice.toFixed(3)} | target $${targetBetUsdc.toFixed(2)}`,
            `Reason: ${rejectMsg}`,
          ].join("\n")
        ).catch((err) => log.warn(TAG, `Telegram reject notify failed: ${err.message}`));
      }
      return;
    }

    liveTradesSubmitted += 1;
  }

  const filledShares = Number(orderResult.filledShares || shares);
  const filledPrice = Number(orderResult.filledPrice || edge.marketPrice);
  if (!Number.isFinite(filledShares) || filledShares <= 0 || !Number.isFinite(filledPrice) || filledPrice <= 0) {
    log.warn(TAG, `Invalid fill result; skipping trade record (shares=${filledShares}, price=${filledPrice})`);
    return;
  }
  const cost = +(filledShares * filledPrice).toFixed(4);
  const filledUsdc = Number(orderResult.filledUsdc || cost);
  const fillRatio = Number(orderResult.fillRatio || 1);
  const fillFee = calculateFee(filledPrice, market.feeRateBps);
  const fillEffectiveCost = filledPrice + fillFee + edge.slippage;
  const fillNetEdge = edge.fairProb - fillEffectiveCost;
  const fillEdgePct = edge.fairProb > 0 ? fillNetEdge / edge.fairProb : 0;
  const fillExpectedPnl = fillNetEdge * filledShares;
  const fillPriceDrift = filledPrice - edge.marketPrice;
  const roundRisk = summarizeRoundRisk(windowTrades, {
    side: edge.side,
    shares: filledShares,
    cost,
  });

  if (!config.paperTrade) {
    liveNotionalSubmitted = +(liveNotionalSubmitted + filledUsdc).toFixed(4);
  }

  const trade = {
    timestamp: new Date().toISOString(),
    mode: config.paperTrade ? "paper" : "live",
    windowTs,
    timeRemainingSec: +timeRemaining.toFixed(1),
    side: edge.side,
    tokenId: config.paperTrade ? "paper" : tokenId,
    orderId: config.paperTrade ? null : (orderResult.orderId || null),
    orderStatus: config.paperTrade ? "paper" : (orderResult.orderStatus || orderResult.data?.status || "unknown"),
    btcPrice: +currentPrice.toFixed(2),
    priceSource: currentPriceSource,
    priceToBeat: +startPrice.toFixed(2),
    entryBestBid: +edge.bestBid.toFixed(4),
    entryBestAsk: +edge.quoteBestAsk.toFixed(4),
    entryVwap: +edge.marketPrice.toFixed(4),
    entryWorstPrice: +edge.worstFillPrice.toFixed(4),
    entryFillRatio: +edge.fillRatio.toFixed(4),
    entryOrderLimitPrice: +edge.orderLimitPrice.toFixed(4),
    entryMaxFairPrice: +edge.maxFairEntryPrice.toFixed(4),
    entrySpread: +edge.spread.toFixed(4),
    feeRateBps: market.feeRateBps,
    sigma: +sigma.toExponential(4),
    sigmaMicro: Number.isFinite(volDetails?.microSigmaPerSec) ? +volDetails.microSigmaPerSec.toExponential(4) : null,
    sigmaLastRound: Number.isFinite(volDetails?.roundSigmaPerSec) ? +volDetails.roundSigmaPerSec.toExponential(4) : null,
    sigmaBlend: Number.isFinite(volDetails?.blendedSigmaPerSec) ? +volDetails.blendedSigmaPerSec.toExponential(4) : null,
    volRegime: profile.volRegime,
    volMedianSigma: Number.isFinite(volRegimeInfo.medianSigma) ? +volRegimeInfo.medianSigma.toExponential(4) : null,
    modelSigma: +fairValue.sigmaPerSec.toExponential(4),
    modelLogMoneyness: +fairValue.logMoneyness.toExponential(4),
    modelDiffusion: +fairValue.diffusion.toExponential(4),
    modelDriftAdj: +fairValue.driftAdj.toExponential(4),
    zScore: +fairValue.z.toFixed(3),
    fairProbRaw: +edge.fairProbRaw.toFixed(4),
    fairProbModel: +fairValueModel.pUp.toFixed(4),
    fairProbAdjusted: +fairValue.pUp.toFixed(4),
    fairProb: +edge.fairProb.toFixed(4),
    chainlinkPrice: Number.isFinite(fairValue.chainlinkPrice) ? +fairValue.chainlinkPrice.toFixed(2) : null,
    chainlinkSignal: fairValue.chainlinkSignal,
    chainlinkMoveBps: fairValue.chainlinkMoveBps,
    marketPrice: +filledPrice.toFixed(4),
    signalPrice: +edge.marketPrice.toFixed(4),
    fee: +edge.fee.toFixed(4),
    fillFee: +fillFee.toFixed(4),
    slippage: +edge.slippage.toFixed(4),
    effectiveCost: +edge.effectiveCost.toFixed(4),
    fillEffectiveCost: +fillEffectiveCost.toFixed(4),
    netEdge: +edge.netEdge.toFixed(4),
    fillNetEdge: +fillNetEdge.toFixed(4),
    expectedPnl: +edge.expectedPnl.toFixed(4),
    fillExpectedPnl: +fillExpectedPnl.toFixed(4),
    edgePct: +(edge.edgePct * 100).toFixed(1),
    fillEdgePct: +(fillEdgePct * 100).toFixed(1),
    fillPriceDrift: +fillPriceDrift.toFixed(4),
    executionOrderType: config.paperTrade ? "PAPER" : (orderResult.orderTypeUsed || config.executionOrderType),
    executionLimitPrice: +Number(orderResult.limitPriceUsed || edge.orderLimitPrice).toFixed(4),
    executionFillSource: orderResult.fillSource || "n/a",
    strategyProfile: profile.label,
    edgeThresholdUsed: +(profile.edgeThreshold * 100).toFixed(2),
    minNetEdgeUsed: +profile.minNetEdge.toFixed(4),
    targetBetUsdc: +targetBetUsdc.toFixed(2),
    sameWindowTradeNo: windowTrades.length + 1,
    sameSideTradeNo: sameSideTrades.length + 1,
    roundPnlIfUp: +roundRisk.pnlIfUp.toFixed(4),
    roundPnlIfDown: +roundRisk.pnlIfDown.toFixed(4),
    roundWorstCaseLoss: +roundRisk.worstCaseLoss.toFixed(4),
    roundUpCost: +roundRisk.upCost.toFixed(4),
    roundDownCost: +roundRisk.downCost.toFixed(4),
    shares: +filledShares.toFixed(4),
    cost: +cost.toFixed(4),
    betSize: +filledUsdc.toFixed(4),
    // filled on resolution
    resolved: false,
    won: null,
    endPrice: null,
    pnl: null,
  };

  tradesData.trades.push(trade);
  saveTrades(tradesData);

  log.trade(TAG, `${config.paperTrade ? "PAPER TRADE" : "LIVE TRADE"}: ${edge.side} @ ${edge.marketPrice}`, {
    profile: profile.label,
    volRegime: profile.volRegime,
    fairRaw: edge.fairProbRaw.toFixed(3),
    fairModel: fairValueModel.pUp.toFixed(3),
    fairAdj: fairValue.pUp.toFixed(3),
    fair: edge.fairProb.toFixed(3),
    chainlinkSignal: fairValue.chainlinkSignal,
    chainlinkMoveBps: fairValue.chainlinkMoveBps,
    bid: edge.bestBid.toFixed(3),
    ask: edge.quoteBestAsk.toFixed(3),
    vwap: edge.marketPrice.toFixed(3),
    filledPx: filledPrice.toFixed(3),
    pxDrift: fillPriceDrift.toFixed(3),
    spread: edge.spread.toFixed(3),
    netEdge: edge.netEdge.toFixed(3),
    fillNetEdge: fillNetEdge.toFixed(3),
    effectiveCost: edge.effectiveCost.toFixed(3),
    fillEffectiveCost: fillEffectiveCost.toFixed(3),
    zScore: fairValue.z.toFixed(3),
    sigma: fairValue.sigmaPerSec.toExponential(3),
    expectedPnl: `$${edge.expectedPnl.toFixed(3)}`,
    fillExpectedPnl: `$${fillExpectedPnl.toFixed(3)}`,
    reason: `${edge.fairProb.toFixed(3)} - (${edge.marketPrice.toFixed(3)} + ${edge.fee.toFixed(3)} + ${edge.slippage.toFixed(3)})`,
    fillReason: `${edge.fairProb.toFixed(3)} - (${filledPrice.toFixed(3)} + ${fillFee.toFixed(3)} + ${edge.slippage.toFixed(3)})`,
    edge: `${(edge.edgePct * 100).toFixed(1)}%`,
    fillEdge: `${(fillEdgePct * 100).toFixed(1)}%`,
    shares: filledShares.toFixed(4),
    fillRatio: `${(fillRatio * 100).toFixed(1)}%`,
    targetBet: `$${targetBetUsdc.toFixed(2)}`,
    cost: `$${cost.toFixed(2)}`,
    roundWorstLoss: `$${roundRisk.worstCaseLoss.toFixed(2)}`,
    roundPnlIfUp: `$${roundRisk.pnlIfUp.toFixed(2)}`,
    roundPnlIfDown: `$${roundRisk.pnlIfDown.toFixed(2)}`,
    priceToBeat: `$${startPrice.toFixed(2)}`,
    btc: `$${currentPrice.toFixed(2)}`,
    priceSource: currentPriceSource,
    orderId: trade.orderId,
    liveRunUsage: config.paperTrade ? undefined : `${liveTradesSubmitted}/${config.liveMaxTradesPerRun} trades, $${liveNotionalSubmitted.toFixed(2)}/$${config.liveMaxNotionalUsdc}`,
  });

  stats.recordTrade({
    windowTs,
    side: edge.side,
    entryPrice: filledPrice,
    size: filledShares,
    tokenId: trade.tokenId,
    timestamp: Date.now(),
  });

  if (config.telegramNotifyEntries) {
    await refreshLiveCashBalance(false).catch(() => {});
    const { totalBalance, realizedPnl, openPositions } = getSummarySnapshot();
    const balanceLabel = config.paperTrade ? "Total balance" : "Cash balance";
    notifyTelegram(
      [
        `NEW ${config.paperTrade ? "PAPER" : "LIVE"} TRADE`,
        `${trade.side} @ ${trade.marketPrice.toFixed(3)} | shares ${trade.shares.toFixed(4)} | cost $${trade.cost.toFixed(2)}`,
        `Signal EV: $${trade.expectedPnl.toFixed(3)} (${trade.edgePct.toFixed(1)}%) | profile: ${trade.strategyProfile}`,
        `Vol regime: ${trade.volRegime}`,
        `Filled EV: $${trade.fillExpectedPnl.toFixed(3)} (${trade.fillEdgePct.toFixed(1)}%) | price drift ${trade.fillPriceDrift.toFixed(3)}`,
        `Why: ${String(trade.priceSource || "price").toUpperCase()} $${trade.btcPrice.toFixed(2)} vs target $${trade.priceToBeat.toFixed(2)} | fair(model→adj)=${trade.fairProbModel.toFixed(3)}→${trade.fairProb.toFixed(3)}`,
        `Chainlink: ${trade.chainlinkSignal} | move=${trade.chainlinkMoveBps ?? "n/a"} bps | target bet $${trade.targetBetUsdc.toFixed(2)}`,
        `Cost math (signal): vwap ${trade.signalPrice.toFixed(3)} + fee ${trade.fee.toFixed(3)} + slip ${trade.slippage.toFixed(3)} = ${trade.effectiveCost.toFixed(3)} < fair ${trade.fairProb.toFixed(3)}`,
        `Cost math (fill): fill ${trade.marketPrice.toFixed(3)} + fee ${trade.fillFee.toFixed(3)} + slip ${trade.slippage.toFixed(3)} = ${trade.fillEffectiveCost.toFixed(3)}`,
        `Round risk: worst loss $${trade.roundWorstCaseLoss.toFixed(2)} (if Up $${trade.roundPnlIfUp.toFixed(2)} / if Down $${trade.roundPnlIfDown.toFixed(2)})`,
        `Window: ${trade.windowTs} | timeLeft: ${trade.timeRemainingSec}s`,
        `Open positions: ${openPositions}`,
        `Realized PnL: $${realizedPnl.toFixed(2)} | ${balanceLabel}: $${totalBalance.toFixed(2)}`,
      ].join("\n")
    ).catch((err) => log.warn(TAG, `Telegram entry notify failed: ${err.message}`));
  }
}

async function onWindowTransition(prevWindowTs, newWindowTs, priceTracker) {
  log.info(TAG, `Window transition: ${prevWindowTs} -> ${newWindowTs}`);

  // Check if we have unresolved trades for the previous window
  const unresolvedTrades = tradesData.trades.filter((t) => t.windowTs === prevWindowTs && !t.resolved);
  if (unresolvedTrades.length === 0) return;

  // Fetch official resolution from Polymarket past-results API
  // Retry with increasing delays: 10s, 30s, 60s
  const delays = [10000, 30000, 60000];
  let resolution = null;

  for (const delay of delays) {
    await new Promise((r) => setTimeout(r, delay));
    resolution = await priceTracker.fetchResolution(prevWindowTs);
    if (resolution) break;
    log.info(TAG, `Resolution not yet available for ${prevWindowTs}, retrying in ${delays[delays.indexOf(delay) + 1] / 1000 || "?"}s...`);
  }

  if (!resolution) {
    const fallback = await priceTracker.fetchResolutionFromCandles(prevWindowTs);
    if (fallback) {
      resolution = fallback;
      log.warn(
        TAG,
        `Using fallback candle resolution for window ${prevWindowTs} (${fallback.outcome.toUpperCase()} open=$${fallback.openPrice.toFixed(2)} close=$${fallback.closePrice.toFixed(2)})`
      );
    }
  }

  if (resolution) {
    const upWon = resolution.outcome === "up";
    log.info(
      TAG,
      `Window ${prevWindowTs} RESOLVED: ${resolution.outcome.toUpperCase()} (open=$${resolution.openPrice.toFixed(2)} close=$${resolution.closePrice.toFixed(2)} source=${resolution.source || "past-results"})`
    );

    for (const trade of unresolvedTrades) {
      const won = (trade.side === "Up" && upWon) || (trade.side === "Down" && !upWon);
      trade.resolved = true;
      trade.resolvedAt = new Date().toISOString();
      trade.won = won;
      trade.resolutionSource = resolution.source || "past-results";
      trade.resolutionOutcome = resolution.outcome;
      trade.windowOpenPrice = +resolution.openPrice.toFixed(2);
      trade.endPrice = +resolution.closePrice.toFixed(2);
      trade.pnl = won ? +(trade.shares - trade.cost).toFixed(4) : -trade.cost;

      log.trade(TAG, `${won ? "WIN" : "LOSS"}: ${trade.side} @ ${trade.marketPrice} -> pnl $${trade.pnl.toFixed(2)}`, {
        open: trade.windowOpenPrice,
        close: trade.endPrice,
        outcome: trade.resolutionOutcome,
        source: trade.resolutionSource,
        expectedPnl: trade.expectedPnl,
      });
      stats.resolveTrade(prevWindowTs, won);
    }

    saveTrades(tradesData);

    if (config.telegramNotifyResolutions) {
      await refreshLiveCashBalance(false).catch(() => {});
      const { totalBalance, realizedPnl, summary } = getSummarySnapshot();
      const balanceLabel = config.paperTrade ? "Total balance" : "Cash balance";
      for (const trade of unresolvedTrades) {
        notifyTelegram(
          [
            `CLOSED ${trade.won ? "WIN" : "LOSS"} (${config.paperTrade ? "PAPER" : "LIVE"})`,
            `${trade.side} @ ${trade.marketPrice.toFixed(3)} -> PnL $${trade.pnl.toFixed(2)}`,
            `Window close: ${trade.endPrice.toFixed(2)} | Outcome: ${trade.resolutionOutcome?.toUpperCase()}`,
            `Resolved: ${summary.resolved || 0}/${summary.totalTrades || 0}`,
            `Realized PnL: $${realizedPnl.toFixed(2)} | ${balanceLabel}: $${totalBalance.toFixed(2)}`,
          ].join("\n")
        ).catch((err) => log.warn(TAG, `Telegram resolution notify failed: ${err.message}`));
      }
    }
  } else {
    log.warn(TAG, `Could not fetch resolution for window ${prevWindowTs} after retries`);
  }
}

main().catch((err) => {
  log.error(TAG, `Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
