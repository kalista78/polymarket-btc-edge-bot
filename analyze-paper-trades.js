const fs = require("fs");
const path = require("path");

const TRADES_FILE = path.resolve(__dirname, "paper-trades.json");

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function summarize(trades) {
  if (!trades.length) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      wagered: 0,
      pnl: 0,
      roi: 0,
    };
  }

  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.length - wins;
  const wagered = trades.reduce((s, t) => s + (Number(t.cost) || 0), 0);
  const pnl = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const winRate = wins / trades.length;
  const roi = wagered > 0 ? pnl / wagered : 0;

  return {
    trades: trades.length,
    wins,
    losses,
    winRate,
    wagered,
    pnl,
    roi,
  };
}

function printSummary(label, stats) {
  console.log(`${label}`);
  console.log(
    `  trades=${stats.trades} wins=${stats.wins} losses=${stats.losses} winRate=${pct(stats.winRate)} pnl=$${stats.pnl.toFixed(2)} roi=${pct(stats.roi)}`
  );
}

function main() {
  if (!fs.existsSync(TRADES_FILE)) {
    console.error(`Missing ${TRADES_FILE}`);
    process.exit(1);
  }

  const payload = JSON.parse(fs.readFileSync(TRADES_FILE, "utf8"));
  const resolved = (payload.trades || []).filter((t) => t.resolved && Number.isFinite(Number(t.pnl)));

  if (!resolved.length) {
    console.log("No resolved trades yet. Run longer paper sessions first.");
    process.exit(0);
  }

  const baseline = summarize(resolved);
  printSummary("Baseline", baseline);
  console.log("");

  const edgeThresholds = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35];
  const netEdges = [0.01, 0.015, 0.02, 0.03, 0.04, 0.05];
  const minTrades = 10;
  const rows = [];

  for (const edgeThreshold of edgeThresholds) {
    for (const minNetEdge of netEdges) {
      const subset = resolved.filter((t) => {
        const edgePct = Number(t.edgePct) / 100;
        const netEdge = Number(t.netEdge || 0);
        return edgePct >= edgeThreshold && netEdge >= minNetEdge;
      });

      if (subset.length < minTrades) continue;

      const stats = summarize(subset);
      rows.push({
        edgeThreshold,
        minNetEdge,
        ...stats,
      });
    }
  }

  if (!rows.length) {
    console.log(`No threshold combos had at least ${minTrades} trades.`);
    process.exit(0);
  }

  console.log(`Top by total PnL (min ${minTrades} trades):`);
  rows
    .slice()
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 10)
    .forEach((r, i) => {
      console.log(
        `  ${i + 1}. edge>=${pct(r.edgeThreshold)} net>=${r.minNetEdge.toFixed(3)} trades=${r.trades} pnl=$${r.pnl.toFixed(2)} roi=${pct(r.roi)} winRate=${pct(r.winRate)}`
      );
    });

  console.log("");
  console.log(`Top by ROI (min ${minTrades} trades):`);
  rows
    .slice()
    .sort((a, b) => b.roi - a.roi)
    .slice(0, 10)
    .forEach((r, i) => {
      console.log(
        `  ${i + 1}. edge>=${pct(r.edgeThreshold)} net>=${r.minNetEdge.toFixed(3)} trades=${r.trades} pnl=$${r.pnl.toFixed(2)} roi=${pct(r.roi)} winRate=${pct(r.winRate)}`
      );
    });
}

main();
