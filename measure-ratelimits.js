const WebSocket = require("ws");

const WS_URL = "wss://ws-live-data.polymarket.com";

// Test 1: Measure messages per second on the stream
// Test 2: Measure if rapid sends get throttled

let msgCount = 0;
let firstMsgTime = null;
let lastMsgTime = null;
let perSecondCounts = {};
let connectionTime = null;

const ws = new WebSocket(WS_URL, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Origin": "https://polymarket.com",
  },
});

let pingInterval;

ws.on("open", () => {
  connectionTime = Date.now();
  console.log("Connected to Polymarket RTDS");
  console.log("Measuring message rates for 30 seconds...\n");

  pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send("ping");
  }, 10000);

  // Subscribe to ALL crypto prices (both feeds, no symbol filter) to see max throughput
  ws.send(JSON.stringify({
    action: "subscribe",
    subscriptions: [
      { topic: "crypto_prices", type: "update", filters: JSON.stringify({}) },
    ],
  }));

  setTimeout(() => {
    ws.send(JSON.stringify({
      action: "subscribe",
      subscriptions: [
        { topic: "crypto_prices_chainlink", type: "update", filters: JSON.stringify({}) },
      ],
    }));
  }, 1000);
});

ws.on("message", (data) => {
  const now = Date.now();
  const str = data.toString();

  if (!str || str.length < 10) return;

  let msg;
  try {
    msg = JSON.parse(str);
  } catch {
    return;
  }

  // Count rate limit / error messages
  if (msg.message === "Too Many Requests") {
    console.log(`[429] Rate limited at ${new Date().toISOString()}`);
    return;
  }

  if (msg.statusCode === 400) {
    console.log(`[400] Bad request: ${JSON.stringify(msg.body || msg).slice(0, 200)}`);
    return;
  }

  if (!msg.payload) return;

  msgCount++;
  if (!firstMsgTime) firstMsgTime = now;
  lastMsgTime = now;

  // Track per-second message counts
  const sec = Math.floor((now - connectionTime) / 1000);
  perSecondCounts[sec] = (perSecondCounts[sec] || 0) + 1;

  // Log topic breakdown
  if (msgCount <= 5) {
    const topic = msg.topic || "unknown";
    const payload = msg.payload;
    let symbol = "?";
    if (payload.symbol) symbol = payload.symbol;
    else if (payload.data && payload.data[0]) symbol = "(batch)";
    console.log(`  msg#${msgCount} topic=${topic} symbol=${symbol}`);
  }
});

ws.on("error", (err) => {
  console.error("WebSocket error:", err.message);
});

ws.on("close", (code) => {
  clearInterval(pingInterval);
  console.log(`\nDisconnected (code: ${code}).`);
});

setTimeout(() => {
  console.log("\n\n--- 30 seconds elapsed ---\n");

  const duration = lastMsgTime && firstMsgTime ? (lastMsgTime - firstMsgTime) / 1000 : 0;
  const avgRate = duration > 0 ? msgCount / duration : 0;

  console.log("=".repeat(60));
  console.log("RATE LIMIT ANALYSIS");
  console.log("=".repeat(60));
  console.log(`Total messages received: ${msgCount}`);
  console.log(`Duration: ${duration.toFixed(1)}s`);
  console.log(`Average rate: ${avgRate.toFixed(2)} msgs/sec`);

  const secKeys = Object.keys(perSecondCounts).map(Number).sort((a, b) => a - b);
  const rates = secKeys.map((k) => perSecondCounts[k]);
  if (rates.length > 0) {
    const maxRate = Math.max(...rates);
    const minRate = Math.min(...rates);
    const avgSecRate = rates.reduce((a, b) => a + b, 0) / rates.length;
    console.log(`\nPer-second breakdown:`);
    console.log(`  Min msgs/sec: ${minRate}`);
    console.log(`  Max msgs/sec: ${maxRate}`);
    console.log(`  Avg msgs/sec: ${avgSecRate.toFixed(1)}`);
    console.log(`\nPer-second counts: [${rates.join(", ")}]`);
  }

  console.log("=".repeat(60));

  ws.close();
  process.exit(0);
}, 30000);
