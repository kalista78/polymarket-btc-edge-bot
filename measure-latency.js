const WebSocket = require("ws");

const WS_URL = "wss://ws-live-data.polymarket.com";

// Track latency stats per feed
const stats = {
  crypto_prices: { delays: [], count: 0, lastValue: null, lastTs: null, label: "Binance (via Polymarket)" },
  crypto_prices_chainlink: { delays: [], count: 0, lastValue: null, lastTs: null, label: "Chainlink (via Polymarket)" },
};

// Cross-feed comparison
const crossDelays = [];
let debugCount = 0;

const ws = new WebSocket(WS_URL, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Origin": "https://polymarket.com",
  },
});

let pingInterval;

ws.on("open", () => {
  console.log("Connected to Polymarket RTDS");
  console.log("Measuring latency... will collect 60 seconds of data.\n");

  // Keepalive ping every 10s
  pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send("ping");
  }, 10000);

  // Subscribe to Binance BTC
  ws.send(JSON.stringify({
    action: "subscribe",
    subscriptions: [
      { topic: "crypto_prices", type: "update", filters: JSON.stringify({ symbol: "btcusdt" }) },
    ],
  }));

  // Stagger Chainlink subscription
  setTimeout(() => {
    ws.send(JSON.stringify({
      action: "subscribe",
      subscriptions: [
        { topic: "crypto_prices_chainlink", type: "update", filters: JSON.stringify({ symbol: "btc/usd" }) },
      ],
    }));
  }, 2000);
});

ws.on("message", (data) => {
  const receiveTime = Date.now();
  const str = data.toString();

  if (!str || str.length < 5) return; // pong or empty

  // Debug: log first few raw messages to understand format
  if (debugCount < 3 && str.includes("payload")) {
    console.log("RAW MSG SAMPLE:", str.slice(0, 500), "\n");
    debugCount++;
  }

  let msg;
  try {
    msg = JSON.parse(str);
  } catch {
    return;
  }

  if (!msg.payload) return;

  const topic = msg.topic || "unknown";
  const payload = msg.payload;

  // Handle batch format: { payload: { data: [{timestamp, value}, ...] } }
  if (payload.data && Array.isArray(payload.data)) {
    const latestEntry = payload.data[payload.data.length - 1];
    if (!latestEntry || !latestEntry.timestamp) return;

    const { timestamp, value } = latestEntry;
    const delay = receiveTime - timestamp;

    recordUpdate(topic, delay, value, timestamp, receiveTime);
    return;
  }

  // Handle single format: { payload: { symbol, timestamp, value } }
  if (payload.timestamp && payload.value !== undefined) {
    const { timestamp, value } = payload;
    const delay = receiveTime - timestamp;

    recordUpdate(topic, delay, value, timestamp, receiveTime);
    return;
  }
});

function recordUpdate(topic, delay, value, timestamp, receiveTime) {
  const s = stats[topic];
  if (!s) return;

  s.delays.push(delay);
  s.count++;
  s.lastValue = value;
  s.lastTs = timestamp;

  // Cross-feed tracking
  if (topic === "crypto_prices") {
    const cl = stats.crypto_prices_chainlink;
    if (cl.lastTs) {
      crossDelays.push({
        binanceTs: timestamp,
        chainlinkTs: cl.lastTs,
        delta: timestamp - cl.lastTs,
        priceDiff: Math.abs(value - cl.lastValue),
      });
    }
  } else if (topic === "crypto_prices_chainlink") {
    const bn = stats.crypto_prices;
    if (bn.lastTs) {
      crossDelays.push({
        binanceTs: bn.lastTs,
        chainlinkTs: timestamp,
        delta: bn.lastTs - timestamp,
        priceDiff: Math.abs(value - bn.lastValue),
      });
    }
  }

  const tag = topic === "crypto_prices" ? "BINANCE " : (topic === "crypto_prices_chainlink" ? "CHAINLNK" : topic.slice(0, 8).toUpperCase());

  // Only log every 5th message to reduce noise
  if (s.count % 5 === 0 || s.count <= 3) {
    const ts = new Date(timestamp);
    const tsStr = isNaN(ts.getTime()) ? String(timestamp) : ts.toISOString();
    console.log(
      `[${tag}] BTC $${String(value).padEnd(12)} | delay: ${String(delay).padStart(6)}ms | ts: ${tsStr}`
    );
  }
}

ws.on("error", (err) => {
  console.error("WebSocket error:", err.message);
});

ws.on("close", (code, reason) => {
  clearInterval(pingInterval);
  console.log(`\nDisconnected (code: ${code}).`);
});

// Run for 60 seconds then print report
setTimeout(() => {
  console.log("\n\n--- 60 seconds elapsed ---\n");
  printReport();
  ws.close();
  process.exit(0);
}, 60000);

function printReport() {
  console.log("=".repeat(70));
  console.log("LATENCY REPORT — Polymarket RTDS BTC Price Feeds");
  console.log("=".repeat(70));

  for (const [topic, s] of Object.entries(stats)) {
    if (s.delays.length === 0) {
      console.log(`\n${s.label}: No data received`);
      continue;
    }

    const sorted = [...s.delays].sort((a, b) => a - b);
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const min = sorted[0];
    const max = sorted[sorted.length - 1];

    console.log(`\n${s.label}:`);
    console.log(`  Messages received: ${s.count}`);
    console.log(`  Avg delay:    ${avg.toFixed(1)}ms`);
    console.log(`  Median delay: ${median}ms`);
    console.log(`  P95 delay:    ${p95}ms`);
    console.log(`  P99 delay:    ${p99}ms`);
    console.log(`  Min delay:    ${min}ms`);
    console.log(`  Max delay:    ${max}ms`);
    console.log(`  Update freq:  ~${(60000 / s.count).toFixed(0)}ms between updates`);
  }

  if (crossDelays.length > 0) {
    const deltas = crossDelays.map((d) => d.delta);
    const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const priceDiffs = crossDelays.map((d) => d.priceDiff);
    const avgPriceDiff = priceDiffs.reduce((a, b) => a + b, 0) / priceDiffs.length;
    const maxPriceDiff = Math.max(...priceDiffs);

    console.log(`\nBinance vs Chainlink (cross-feed comparison):`);
    console.log(`  Samples: ${crossDelays.length}`);
    console.log(`  Avg Binance leads Chainlink by: ${avgDelta.toFixed(1)}ms`);
    console.log(`  Avg price difference: $${avgPriceDiff.toFixed(2)}`);
    console.log(`  Max price difference: $${maxPriceDiff.toFixed(2)}`);
  }

  console.log("\n" + "=".repeat(70));
  console.log("NOTE: 'delay' = Date.now() - message timestamp.");
  console.log("Includes your local clock offset + network + Polymarket relay.");
  console.log("A negative delay means the source timestamp is in the future");
  console.log("relative to your clock (clock skew).");
  console.log("=".repeat(70));
}
