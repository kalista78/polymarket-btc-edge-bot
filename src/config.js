require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const config = {
  // Polymarket CLOB API credentials (L2 HMAC)
  privateKey: process.env.PRIVATE_KEY || "",
  apiKey: process.env.POLY_API_KEY || "",
  apiSecret: process.env.POLY_SECRET || "",
  apiPassphrase: process.env.POLY_PASSPHRASE || "",
  funderAddress: process.env.FUNDER_ADDRESS || "",
  signatureType: parseInt(process.env.SIGNATURE_TYPE || "1", 10), // 0=EOA, 1=Proxy, 2=Gnosis
  chainId: parseInt(process.env.CHAIN_ID || "137", 10), // Polygon mainnet by default
  // Optional builder attribution / relayer signing config
  polyBuilderApiKey: process.env.POLY_BUILDER_API_KEY || "",
  polyBuilderSecret: process.env.POLY_BUILDER_SECRET || "",
  polyBuilderPassphrase: process.env.POLY_BUILDER_PASSPHRASE || "",
  builderSignerUrl: process.env.BUILDER_SIGNER_URL || "",
  builderSignerToken: process.env.BUILDER_SIGNER_TOKEN || "",

  // Strategy parameters
  edgeThreshold: parseFloat(process.env.EDGE_THRESHOLD || "0.20"),
  positionSizeUsdc: parseFloat(process.env.POSITION_SIZE_USDC || "5"),
  minTimeRemainingSec: parseInt(process.env.MIN_TIME_REMAINING_SEC || "60", 10),
  volWindowSec: parseInt(process.env.VOL_WINDOW_SEC || "300", 10),
  maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || "3", 10),
  maxDailyLossUsdc: parseFloat(process.env.MAX_DAILY_LOSS_USDC || "100"),
  minNetEdge: parseFloat(process.env.MIN_NET_EDGE || "0.02"), // absolute edge/share in probability points
  minExpectedPnlUsdc: parseFloat(process.env.MIN_EXPECTED_PNL_USDC || "0.05"),
  slippageBuffer: parseFloat(process.env.SLIPPAGE_BUFFER || "0.003"),
  sameWindowMinPriceDelta: parseFloat(process.env.SAME_WINDOW_MIN_PRICE_DELTA || "0.15"),
  minEntryPrice: parseFloat(process.env.MIN_ENTRY_PRICE || "0.30"),
  maxEntryPrice: parseFloat(process.env.MAX_ENTRY_PRICE || "0.75"),
  maxSpread: parseFloat(process.env.MAX_SPREAD || "0.08"),
  probabilityShrink: parseFloat(process.env.PROBABILITY_SHRINK || "0.85"),
  minProbability: parseFloat(process.env.MIN_PROBABILITY || "0.001"),
  maxProbability: parseFloat(process.env.MAX_PROBABILITY || "0.999"),
  driftPerSec: parseFloat(process.env.DRIFT_PER_SEC || "0"),
  minSigmaPerSec: parseFloat(process.env.MIN_SIGMA_PER_SEC || "0.000005"),
  maxSigmaPerSec: parseFloat(process.env.MAX_SIGMA_PER_SEC || "0.005"),

  // Market constants
  windowDurationSec: 300, // 5 minutes
  feeRateBps: 0, // fallback fee in bps when API data is unavailable

  // Network
  rtdsUrl: "wss://ws-live-data.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",
  gammaBaseUrl: "https://gamma-api.polymarket.com",

  // Intervals
  edgeCheckIntervalMs: 5000,
  marketDiscoveryIntervalMs: 30000,
  pingIntervalMs: 10000,
  watchdogTimeoutMs: 60000,

  // Reconnect
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
  rateLimitCooldownMs: parseInt(process.env.RATE_LIMIT_COOLDOWN_MS || "5000", 10),

  // Mode
  paperTrade: process.env.PAPER_TRADE !== "false", // default true
  enableLiveOrders: process.env.ENABLE_LIVE_ORDERS === "true",
  liveAcknowledge: process.env.LIVE_ACKNOWLEDGE || "",
  liveMaxTradesPerRun: parseInt(process.env.LIVE_MAX_TRADES_PER_RUN || "8", 10),
  liveMaxNotionalUsdc: parseFloat(process.env.LIVE_MAX_NOTIONAL_USDC || "100"),
};

// Validate required credentials for live trading
config.validate = function () {
  if (!this.paperTrade) {
    const required = ["privateKey", "apiKey", "apiSecret", "apiPassphrase"];
    const missing = required.filter((k) => !this[k]);
    if (missing.length > 0) {
      throw new Error(`Missing required env vars for live trading: ${missing.join(", ")}`);
    }
  }

  if (![0, 1, 2].includes(this.signatureType)) {
    throw new Error("SIGNATURE_TYPE must be one of: 0 (EOA), 1 (Proxy), 2 (Gnosis)");
  }

  if (!this.paperTrade && (this.signatureType === 1 || this.signatureType === 2) && !this.funderAddress) {
    throw new Error("FUNDER_ADDRESS is required for SIGNATURE_TYPE 1/2 (proxy/safe trading)");
  }

  if (this.enableLiveOrders && this.paperTrade) {
    throw new Error("ENABLE_LIVE_ORDERS=true requires PAPER_TRADE=false");
  }

  if (this.enableLiveOrders && this.liveAcknowledge !== "I_UNDERSTAND_REAL_TRADES") {
    throw new Error('Set LIVE_ACKNOWLEDGE=I_UNDERSTAND_REAL_TRADES before enabling real orders');
  }

  const hasLocalBuilderCreds =
    !!this.polyBuilderApiKey || !!this.polyBuilderSecret || !!this.polyBuilderPassphrase;
  const localBuilderAllSet =
    !!this.polyBuilderApiKey && !!this.polyBuilderSecret && !!this.polyBuilderPassphrase;

  if (hasLocalBuilderCreds && !localBuilderAllSet) {
    throw new Error(
      "POLY_BUILDER_API_KEY/POLY_BUILDER_SECRET/POLY_BUILDER_PASSPHRASE must all be set together"
    );
  }

  if (this.builderSignerUrl && !/^https?:\/\//.test(this.builderSignerUrl)) {
    throw new Error("BUILDER_SIGNER_URL must start with http:// or https://");
  }

  if (this.liveMaxTradesPerRun <= 0) {
    throw new Error("LIVE_MAX_TRADES_PER_RUN must be > 0");
  }

  if (this.liveMaxNotionalUsdc <= 0) {
    throw new Error("LIVE_MAX_NOTIONAL_USDC must be > 0");
  }

  if (this.minProbability <= 0 || this.maxProbability >= 1 || this.minProbability >= this.maxProbability) {
    throw new Error("MIN_PROBABILITY/MAX_PROBABILITY must satisfy 0 < min < max < 1");
  }

  if (this.minEntryPrice <= 0 || this.maxEntryPrice >= 1 || this.minEntryPrice >= this.maxEntryPrice) {
    throw new Error("MIN_ENTRY_PRICE/MAX_ENTRY_PRICE must satisfy 0 < min < max < 1");
  }

  if (this.sameWindowMinPriceDelta <= 0 || this.sameWindowMinPriceDelta >= 1) {
    throw new Error("SAME_WINDOW_MIN_PRICE_DELTA must satisfy 0 < value < 1");
  }
};

module.exports = config;
