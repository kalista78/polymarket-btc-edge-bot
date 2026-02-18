const config = require("./src/config");
const MarketDiscovery = require("./src/execution/market-discovery");
const { fetchBothBooks } = require("./src/execution/orderbook");
const { runLivePreflight } = require("./src/execution/order");

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  console.log("=== Polymarket Live Preflight ===");
  console.log(`Mode: ${config.paperTrade ? "PAPER" : "LIVE"}`);

  try {
    config.validate();
  } catch (err) {
    console.error(`Config validation failed: ${err.message}`);
    process.exit(1);
  }

  const report = await runLivePreflight();
  console.log("\nAuth/Connectivity:");
  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) {
    console.error("\nPreflight failed before market checks.");
    process.exit(1);
  }

  const marketDiscovery = new MarketDiscovery();
  const windowTs = Math.floor(Date.now() / 1000 / config.windowDurationSec) * config.windowDurationSec;
  const market = await marketDiscovery.discover(windowTs);

  if (!market) {
    console.error("\nCould not discover the current BTC 5m market.");
    process.exit(1);
  }

  const books = await fetchBothBooks(market.upTokenId, market.downTokenId);
  if (!books?.up && !books?.down) {
    console.error("\nCould not fetch order books for active market.");
    process.exit(1);
  }

  const upAsk = toNum(books?.up?.bestAsk);
  const downAsk = toNum(books?.down?.bestAsk);
  const maxEntry = config.positionSizeUsdc;

  const summary = {
    market: {
      slug: market.slug,
      windowTs: market.windowTs,
      feeRateBps: market.feeRateBps,
      upTokenId: market.upTokenId,
      downTokenId: market.downTokenId,
    },
    bestAsks: {
      up: upAsk,
      down: downAsk,
    },
    estSharesForBetSize: {
      betSizeUsdc: maxEntry,
      up: upAsk ? +(maxEntry / upAsk).toFixed(4) : null,
      down: downAsk ? +(maxEntry / downAsk).toFixed(4) : null,
    },
    liveGuards: {
      enableLiveOrders: config.enableLiveOrders,
      liveMaxTradesPerRun: config.liveMaxTradesPerRun,
      liveMaxNotionalUsdc: config.liveMaxNotionalUsdc,
      acknowledgeSet: config.liveAcknowledge === "I_UNDERSTAND_REAL_TRADES",
    },
  };

  console.log("\nMarket/Execution Readiness:");
  console.log(JSON.stringify(summary, null, 2));

  const collateral = toNum(report?.checks?.collateral?.balance);
  if (collateral !== null && collateral < config.positionSizeUsdc) {
    console.error(
      `\nInsufficient collateral balance (${collateral}) for one entry of ${config.positionSizeUsdc} USDC.`
    );
    process.exit(1);
  }

  console.log("\nPreflight passed.");
}

main().catch((err) => {
  console.error(`Fatal preflight error: ${err.message}`);
  process.exit(1);
});
