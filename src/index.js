const fs = require("fs");
const path = require("path");
const config = require("./config");
const log = require("./utils/logger");
const stats = require("./utils/stats");
const RtdsClient = require("./feeds/rtds");
const PriceTracker = require("./feeds/price-tracker");
const { calculateFairValue } = require("./strategy/fair-value");
const { detectEdge } = require("./strategy/edge-detector");
const MarketDiscovery = require("./execution/market-discovery");
const { fetchBothBooks } = require("./execution/orderbook");
const { placeOrder } = require("./execution/order");
const TelegramBot = require("./integrations/telegram");

const TAG = "MAIN";
const BET_SIZE = config.positionSizeUsdc;
const ASCII_BANNER = String.raw`
 ____       _                  _             _        _   
|  _ \ ___ | |_   _ _ __ ___  | | ___   ___| | _____| |_ 
| |_) / _ \| | | | | '_ \` _ \ | |/ _ \ / __| |/ / _ \ __|
|  __/ (_) | | |_| | | | | | || | (_) | (__|   <  __/ |_ 
|_|   \___/|_|\__, |_| |_| |_||_|\___/ \___|_|\_\___|\__|
              |___/                    BTC 5m Edge Bot
`;

// Paper trades JSON log
const TRADES_FILE = path.resolve(__dirname, "../paper-trades.json");

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

function getTodayRealizedPnl() {
  if (!tradesData || !Array.isArray(tradesData.trades)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  return tradesData.trades
    .filter((t) => t.resolved && typeof t.resolvedAt === "string" && t.resolvedAt.startsWith(today))
    .reduce((s, t) => s + (Number(t.pnl) || 0), 0);
}

function getSummarySnapshot() {
  const summary = tradesData?.summary || {};
  const openPositions = tradesData?.trades?.filter((t) => !t.resolved).length || 0;
  const realizedPnl = Number(summary.totalPnl || 0);
  const totalBalance = +(config.startingBalanceUsdc + realizedPnl).toFixed(2);
  return {
    summary,
    openPositions,
    realizedPnl,
    totalBalance,
  };
}

async function notifyTelegram(text) {
  if (!telegram) return;
  await telegram.sendMessage(text);
}

function formatStatusMessage(currentPrice) {
  const { summary, openPositions, realizedPnl, totalBalance } = getSummarySnapshot();
  const mode = config.paperTrade ? "PAPER" : "LIVE";
  const state = tradingPaused ? "PAUSED" : "RUNNING";
  const price = Number.isFinite(currentPrice) ? `$${currentPrice.toFixed(2)}` : "N/A";
  return [
    `Polymarket Bot Status`,
    `Mode: ${mode} (${state})`,
    `BTC: ${price}`,
    `Resolved: ${summary.resolved || 0}/${summary.totalTrades || 0}`,
    `Open positions: ${openPositions}`,
    `Realized PnL: $${realizedPnl.toFixed(2)}`,
    `Total balance: $${totalBalance.toFixed(2)}`,
    `Win rate: ${(summary.winRate || 0).toFixed(1)}%`,
    `ROI: ${(summary.roi || 0).toFixed(1)}%`,
  ].join("\n");
}

async function main() {
  console.log(ASCII_BANNER);
  log.info(TAG, "=== Polymarket BTC 5-Min Mispricing Bot ===");
  log.info(TAG, `Mode: ${config.paperTrade ? "PAPER TRADING" : "LIVE TRADING"}`);
  log.info(TAG, `Edge threshold: ${(config.edgeThreshold * 100).toFixed(0)}% + min net edge ${config.minNetEdge.toFixed(3)}`);
  log.info(TAG, `Bet size: $${BET_SIZE} per trade`);
  log.info(TAG, `Same-window re-entry min price delta: $${config.sameWindowMinPriceDelta.toFixed(2)}`);
  log.info(TAG, `Entry band: ${config.minEntryPrice.toFixed(2)} - ${config.maxEntryPrice.toFixed(2)}`);
  log.info(TAG, `Risk: max ${config.maxConcurrentPositions} open / max daily loss $${config.maxDailyLossUsdc}`);
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

    await notifyTelegram(`Bot stopped (${source}).\n${formatStatusMessage(priceTracker.getCurrentPrice())}`);
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
          "Commands:\n/status - current status\n/stop - pause new entries\n/resume - resume entries\n/start - alias of /resume\n/balance - PnL and balance"
        );
        return;
      }

      if (command === "/status" || command === "/balance") {
        await notifyTelegram(formatStatusMessage(priceTracker.getCurrentPrice()));
        return;
      }

      if (command === "/stop" || command === "/pause") {
        tradingPaused = true;
        await notifyTelegram(`Trading paused.\n${formatStatusMessage(priceTracker.getCurrentPrice())}`);
        return;
      }

      if (command === "/resume" || command === "/start") {
        tradingPaused = false;
        await notifyTelegram(`Trading resumed.\n${formatStatusMessage(priceTracker.getCurrentPrice())}`);
        return;
      }
    });

    log.info(TAG, "Telegram integration enabled");
  } else {
    log.info(TAG, "Telegram integration disabled");
  }

  rtds.connect();

  log.info(TAG, "Waiting for price data...");
  await new Promise((resolve) => {
    const check = () => {
      if (priceTracker.getCurrentPrice()) resolve();
      else setTimeout(check, 500);
    };
    check();
  });
  log.info(TAG, `First price received: $${priceTracker.getCurrentPrice().toFixed(2)}`);

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

  await notifyTelegram(`Bot started.\n${formatStatusMessage(priceTracker.getCurrentPrice())}`);

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
    log.info(TAG, `Status: BTC=$${currentPrice.toFixed(2)} window=${windowTs} timeLeft=${timeRemaining.toFixed(0)}s priceToBeat=${startPrice ? "$" + startPrice.toFixed(2) : "N/A"}`);
  }

  if (tradingPaused) return;

  if (timeRemaining < config.minTimeRemainingSec) return;

  const openPositions = tradesData.trades.filter((t) => !t.resolved).length;
  if (openPositions >= config.maxConcurrentPositions) return;

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

  const sigma = priceTracker.getVolatility();
  const fairValue = calculateFairValue(currentPrice, startPrice, sigma, timeRemaining);
  if (!fairValue) return;

  const market = await marketDiscovery.discover(windowTs);
  if (!market) return;

  const books = await fetchBothBooks(market.upTokenId, market.downTokenId);
  if (!books) return;

  const edge = detectEdge(fairValue, books, market.feeRateBps, BET_SIZE);
  if (!edge) return;

  // Allow multiple same-window trades only if market price moved enough from last same-window fill.
  const windowTrades = tradesData.trades.filter((t) => t.windowTs === windowTs);
  const lastWindowTrade = windowTrades.length > 0 ? windowTrades[windowTrades.length - 1] : null;
  if (lastWindowTrade) {
    const delta = Math.abs(edge.marketPrice - lastWindowTrade.marketPrice);
    if (delta < config.sameWindowMinPriceDelta) {
      log.debug(
        TAG,
        `Skip same-window re-entry: delta ${delta.toFixed(3)} < ${config.sameWindowMinPriceDelta.toFixed(3)} (last=${lastWindowTrade.marketPrice.toFixed(3)} now=${edge.marketPrice.toFixed(3)})`
      );
      return;
    }
  }

  // Edge found — optionally place live order, then record trade.
  const tokenId = edge.side === "Up" ? market.upTokenId : market.downTokenId;
  const shares = edge.shares;
  const cost = +(edge.marketPrice * shares).toFixed(4);

  let orderResult = { paper: true };

  if (!config.paperTrade) {
    if (liveTradesSubmitted >= config.liveMaxTradesPerRun) {
      return;
    }

    const projectedNotional = liveNotionalSubmitted + BET_SIZE;
    if (projectedNotional > config.liveMaxNotionalUsdc) {
      return;
    }

    orderResult = await placeOrder({
      tokenId,
      price: edge.marketPrice,
      size: shares,
      usdcAmount: BET_SIZE,
      side: edge.side,
    });

    if (!orderResult || orderResult.skipped) {
      return;
    }

    liveTradesSubmitted += 1;
    liveNotionalSubmitted = +(liveNotionalSubmitted + BET_SIZE).toFixed(4);
  }

  const trade = {
    timestamp: new Date().toISOString(),
    mode: config.paperTrade ? "paper" : "live",
    windowTs,
    timeRemainingSec: +timeRemaining.toFixed(1),
    side: edge.side,
    tokenId: config.paperTrade ? "paper" : tokenId,
    orderId: config.paperTrade ? null : (orderResult.orderId || null),
    orderStatus: config.paperTrade ? "paper" : (orderResult.data?.status || "unknown"),
    btcPrice: +currentPrice.toFixed(2),
    priceToBeat: +startPrice.toFixed(2),
    entryBestBid: +edge.bestBid.toFixed(4),
    entryBestAsk: +edge.marketPrice.toFixed(4),
    entrySpread: +edge.spread.toFixed(4),
    feeRateBps: market.feeRateBps,
    sigma: +sigma.toExponential(4),
    modelSigma: +fairValue.sigmaPerSec.toExponential(4),
    modelLogMoneyness: +fairValue.logMoneyness.toExponential(4),
    modelDiffusion: +fairValue.diffusion.toExponential(4),
    modelDriftAdj: +fairValue.driftAdj.toExponential(4),
    zScore: +fairValue.z.toFixed(3),
    fairProbRaw: +edge.fairProbRaw.toFixed(4),
    fairProb: +edge.fairProb.toFixed(4),
    marketPrice: edge.marketPrice,
    fee: +edge.fee.toFixed(4),
    slippage: +edge.slippage.toFixed(4),
    effectiveCost: +edge.effectiveCost.toFixed(4),
    netEdge: +edge.netEdge.toFixed(4),
    expectedPnl: +edge.expectedPnl.toFixed(4),
    edgePct: +(edge.edgePct * 100).toFixed(1),
    sameWindowTradeNo: windowTrades.length + 1,
    shares,
    cost,
    betSize: BET_SIZE,
    // filled on resolution
    resolved: false,
    won: null,
    endPrice: null,
    pnl: null,
  };

  tradesData.trades.push(trade);
  saveTrades(tradesData);

  log.trade(TAG, `${config.paperTrade ? "PAPER TRADE" : "LIVE TRADE"}: ${edge.side} @ ${edge.marketPrice}`, {
    fairRaw: edge.fairProbRaw.toFixed(3),
    fair: edge.fairProb.toFixed(3),
    bid: edge.bestBid.toFixed(3),
    ask: edge.marketPrice.toFixed(3),
    spread: edge.spread.toFixed(3),
    netEdge: edge.netEdge.toFixed(3),
    effectiveCost: edge.effectiveCost.toFixed(3),
    zScore: fairValue.z.toFixed(3),
    sigma: fairValue.sigmaPerSec.toExponential(3),
    expectedPnl: `$${edge.expectedPnl.toFixed(3)}`,
    reason: `${edge.fairProb.toFixed(3)} - (${edge.marketPrice.toFixed(3)} + ${edge.fee.toFixed(3)} + ${edge.slippage.toFixed(3)})`,
    edge: `${(edge.edgePct * 100).toFixed(1)}%`,
    shares,
    cost: `$${cost}`,
    priceToBeat: `$${startPrice.toFixed(2)}`,
    btc: `$${currentPrice.toFixed(2)}`,
    orderId: trade.orderId,
    liveRunUsage: config.paperTrade ? undefined : `${liveTradesSubmitted}/${config.liveMaxTradesPerRun} trades, $${liveNotionalSubmitted.toFixed(2)}/$${config.liveMaxNotionalUsdc}`,
  });

  stats.recordTrade({
    windowTs,
    side: edge.side,
    entryPrice: edge.marketPrice,
    size: shares,
    tokenId: trade.tokenId,
    timestamp: Date.now(),
  });

  if (config.telegramNotifyEntries) {
    const { totalBalance, realizedPnl, openPositions } = getSummarySnapshot();
    notifyTelegram(
      [
        `NEW ${config.paperTrade ? "PAPER" : "LIVE"} TRADE`,
        `${trade.side} @ ${trade.marketPrice.toFixed(3)} | shares ${trade.shares.toFixed(2)} | cost $${trade.cost.toFixed(2)}`,
        `Expected PnL: $${trade.expectedPnl.toFixed(3)} | Edge: ${trade.edgePct.toFixed(1)}%`,
        `Window: ${trade.windowTs} | timeLeft: ${trade.timeRemainingSec}s`,
        `Open positions: ${openPositions}`,
        `Realized PnL: $${realizedPnl.toFixed(2)} | Total balance: $${totalBalance.toFixed(2)}`,
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
      const { totalBalance, realizedPnl, summary } = getSummarySnapshot();
      for (const trade of unresolvedTrades) {
        notifyTelegram(
          [
            `CLOSED ${trade.won ? "WIN" : "LOSS"} (${config.paperTrade ? "PAPER" : "LIVE"})`,
            `${trade.side} @ ${trade.marketPrice.toFixed(3)} -> PnL $${trade.pnl.toFixed(2)}`,
            `Window close: ${trade.endPrice.toFixed(2)} | Outcome: ${trade.resolutionOutcome?.toUpperCase()}`,
            `Resolved: ${summary.resolved || 0}/${summary.totalTrades || 0}`,
            `Realized PnL: $${realizedPnl.toFixed(2)} | Total balance: $${totalBalance.toFixed(2)}`,
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
