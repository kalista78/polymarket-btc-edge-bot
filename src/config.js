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

  // Reporting / control
  startingBalanceUsdc: parseFloat(process.env.STARTING_BALANCE_USDC || "0"),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  telegramAllowFirstChat: process.env.TELEGRAM_ALLOW_FIRST_CHAT === "true",
  telegramPollIntervalMs: parseInt(process.env.TELEGRAM_POLL_INTERVAL_MS || "3000", 10),
  telegramNotifyEntries: process.env.TELEGRAM_NOTIFY_ENTRIES !== "false",
  telegramNotifyResolutions: process.env.TELEGRAM_NOTIFY_RESOLUTIONS !== "false",
  telegramNotifyClaims: process.env.TELEGRAM_NOTIFY_CLAIMS !== "false",

  // Auto-claim
  autoClaimEnabled: process.env.AUTO_CLAIM_ENABLED === "true",
  autoClaimIntervalMs: parseInt(process.env.AUTO_CLAIM_INTERVAL_MS || "90000", 10),
  dataApiBaseUrl: process.env.DATA_API_BASE_URL || "https://data-api.polymarket.com",
  relayerUrl: process.env.RELAYER_URL || "https://relayer-v2.polymarket.com",
  polygonRpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
  claimSizeThreshold: parseFloat(process.env.CLAIM_SIZE_THRESHOLD || "0"),

  // Strategy parameters
  priceSource: (process.env.PRICE_SOURCE || "candle").toLowerCase(), // candle | chainlink | binance | auto
  candlePollIntervalMs: parseInt(process.env.CANDLE_POLL_INTERVAL_MS || "5000", 10),
  candleStaleMs: parseInt(process.env.CANDLE_STALE_MS || "15000", 10),
  priceDriftThresholdUsd: parseFloat(process.env.PRICE_DRIFT_THRESHOLD_USD || "100"),
  priceStaleMs: parseInt(process.env.PRICE_STALE_MS || "15000", 10),
  edgeThreshold: parseFloat(process.env.EDGE_THRESHOLD || "0.20"),
  positionSizeUsdc: parseFloat(process.env.POSITION_SIZE_USDC || "5"),
  minTimeRemainingSec: parseInt(process.env.MIN_TIME_REMAINING_SEC || "60", 10),
  volWindowSec: parseInt(process.env.VOL_WINDOW_SEC || "300", 10),
  maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || "3", 10),
  maxDailyLossUsdc: parseFloat(process.env.MAX_DAILY_LOSS_USDC || "100"),
  maxRoundLossUsdc: parseFloat(process.env.MAX_ROUND_LOSS_USDC || "10"),
  takeProfitEnabled: process.env.TAKE_PROFIT_ENABLED !== "false",
  takeProfitRoi: parseFloat(process.env.TAKE_PROFIT_ROI || "1.0"), // 1.0 => +100%
  minNetEdge: parseFloat(process.env.MIN_NET_EDGE || "0.02"), // absolute edge/share in probability points
  minExpectedPnlUsdc: parseFloat(process.env.MIN_EXPECTED_PNL_USDC || "0.05"),
  slippageBuffer: parseFloat(process.env.SLIPPAGE_BUFFER || "0.003"),
  sameWindowMinPriceDelta: parseFloat(process.env.SAME_WINDOW_MIN_PRICE_DELTA || "0.07"),
  minEntryPrice: parseFloat(process.env.MIN_ENTRY_PRICE || "0.30"),
  maxEntryPrice: parseFloat(process.env.MAX_ENTRY_PRICE || "0.75"),
  maxSpread: parseFloat(process.env.MAX_SPREAD || "0.08"),
  minBookFillRatio: parseFloat(process.env.MIN_BOOK_FILL_RATIO || "0.70"),
  minBookDepthUsdc: parseFloat(process.env.MIN_BOOK_DEPTH_USDC || "25"),
  probabilityShrink: parseFloat(process.env.PROBABILITY_SHRINK || "0.85"),
  minProbability: parseFloat(process.env.MIN_PROBABILITY || "0.001"),
  maxProbability: parseFloat(process.env.MAX_PROBABILITY || "0.999"),
  driftPerSec: parseFloat(process.env.DRIFT_PER_SEC || "0"),
  minSigmaPerSec: parseFloat(process.env.MIN_SIGMA_PER_SEC || "0.000005"),
  maxSigmaPerSec: parseFloat(process.env.MAX_SIGMA_PER_SEC || "0.005"),
  roundVolBlend: parseFloat(process.env.ROUND_VOL_BLEND || "0.35"),
  roundVolFloorMultiplier: parseFloat(process.env.ROUND_VOL_FLOOR_MULTIPLIER || "0.85"),
  // Volatility regime switching
  volRegimeEnabled: process.env.VOL_REGIME_ENABLED !== "false",
  volRegimeLookback: parseInt(process.env.VOL_REGIME_LOOKBACK || "120", 10),
  volHighMultiplier: parseFloat(process.env.VOL_HIGH_MULTIPLIER || "1.8"),
  volLowMultiplier: parseFloat(process.env.VOL_LOW_MULTIPLIER || "0.7"),
  volHighEdgeFactor: parseFloat(process.env.VOL_HIGH_EDGE_FACTOR || "0.90"),
  volLowEdgeFactor: parseFloat(process.env.VOL_LOW_EDGE_FACTOR || "1.10"),
  // Late-window high-confidence mode
  lateWindowEnabled: process.env.LATE_WINDOW_ENABLED !== "false",
  lateWindowMinTimeSec: parseInt(process.env.LATE_WINDOW_MIN_TIME_SEC || "30", 10),
  lateWindowMaxTimeSec: parseInt(process.env.LATE_WINDOW_MAX_TIME_SEC || "60", 10),
  lateWindowMinZScore: parseFloat(process.env.LATE_WINDOW_MIN_ZSCORE || "3.0"),
  lateWindowEdgeThreshold: parseFloat(process.env.LATE_WINDOW_EDGE_THRESHOLD || "0.05"),
  lateWindowMinNetEdge: parseFloat(process.env.LATE_WINDOW_MIN_NET_EDGE || "0.01"),
  lateWindowSizeMultiplier: parseFloat(process.env.LATE_WINDOW_SIZE_MULTIPLIER || "1.20"),
  lateWindowMaxEntryPrice: parseFloat(process.env.LATE_WINDOW_MAX_ENTRY_PRICE || "0.90"),
  // Chainlink/Binance confirmation
  chainlinkConfirmEnabled: process.env.CHAINLINK_CONFIRM_ENABLED !== "false",
  chainlinkConfirmBoost: parseFloat(process.env.CHAINLINK_CONFIRM_BOOST || "0.015"),
  chainlinkConflictPull: parseFloat(process.env.CHAINLINK_CONFLICT_PULL || "0.20"),
  chainlinkNeutralMoveBps: parseFloat(process.env.CHAINLINK_NEUTRAL_MOVE_BPS || "2"),
  chainlinkAgreeSizeMultiplier: parseFloat(process.env.CHAINLINK_AGREE_SIZE_MULTIPLIER || "1.10"),
  chainlinkDisagreeSizeMultiplier: parseFloat(process.env.CHAINLINK_DISAGREE_SIZE_MULTIPLIER || "0.85"),
  // Adaptive position sizing
  adaptiveSizingEnabled: process.env.ADAPTIVE_SIZING_ENABLED !== "false",
  minPositionSizeUsdc: parseFloat(process.env.MIN_POSITION_SIZE_USDC || "5"),
  maxPositionSizeUsdc: parseFloat(process.env.MAX_POSITION_SIZE_USDC || "25"),
  adaptiveEdgeMultiplier: parseFloat(process.env.ADAPTIVE_EDGE_MULTIPLIER || "6"),
  adaptiveConfidenceMultiplier: parseFloat(process.env.ADAPTIVE_CONFIDENCE_MULTIPLIER || "0.7"),
  // Direction-neutral Up+Down mispricing detector
  combinedArbEnabled: process.env.COMBINED_ARB_ENABLED !== "false",
  combinedArbExecute: process.env.COMBINED_ARB_EXECUTE === "true",
  combinedArbMinNetPerShare: parseFloat(process.env.COMBINED_ARB_MIN_NET_PER_SHARE || "0.02"),
  combinedArbMaxUsdc: parseFloat(process.env.COMBINED_ARB_MAX_USDC || "6"),

  // Execution quality / fill handling
  executionOrderType: (process.env.EXECUTION_ORDER_TYPE || "FAK").toUpperCase(),
  executionMaxRepriceSteps: parseInt(process.env.EXECUTION_MAX_REPRICE_STEPS || "1", 10),
  executionRepriceStep: parseFloat(process.env.EXECUTION_REPRICE_STEP || "0.01"),
  executionPriceBuffer: parseFloat(process.env.EXECUTION_PRICE_BUFFER || "0.005"),
  minLiveFillUsdc: parseFloat(process.env.MIN_LIVE_FILL_USDC || "1.0"),

  // Market constants
  windowDurationSec: 300, // 5 minutes
  feeRateBps: parseFloat(process.env.FEE_RATE_BPS || "1000"),

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

  if (this.startingBalanceUsdc < 0) {
    throw new Error("STARTING_BALANCE_USDC must be >= 0");
  }

  if (this.telegramPollIntervalMs < 1000) {
    throw new Error("TELEGRAM_POLL_INTERVAL_MS must be >= 1000");
  }

  if (this.autoClaimIntervalMs < 15000) {
    throw new Error("AUTO_CLAIM_INTERVAL_MS must be >= 15000");
  }

  if (this.telegramBotToken && !this.telegramChatId && !this.telegramAllowFirstChat) {
    throw new Error(
      "Set TELEGRAM_CHAT_ID or TELEGRAM_ALLOW_FIRST_CHAT=true when TELEGRAM_BOT_TOKEN is set"
    );
  }

  if (this.liveMaxTradesPerRun <= 0) {
    throw new Error("LIVE_MAX_TRADES_PER_RUN must be > 0");
  }

  if (this.liveMaxNotionalUsdc <= 0) {
    throw new Error("LIVE_MAX_NOTIONAL_USDC must be > 0");
  }

  if (this.maxRoundLossUsdc <= 0) {
    throw new Error("MAX_ROUND_LOSS_USDC must be > 0");
  }

  if (this.takeProfitRoi < 0) {
    throw new Error("TAKE_PROFIT_ROI must be >= 0");
  }

  if (this.claimSizeThreshold < 0) {
    throw new Error("CLAIM_SIZE_THRESHOLD must be >= 0");
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

  if (this.minBookFillRatio <= 0 || this.minBookFillRatio > 1) {
    throw new Error("MIN_BOOK_FILL_RATIO must satisfy 0 < value <= 1");
  }

  if (this.minBookDepthUsdc < 0) {
    throw new Error("MIN_BOOK_DEPTH_USDC must be >= 0");
  }

  if (!["candle", "chainlink", "binance", "auto"].includes(this.priceSource)) {
    throw new Error("PRICE_SOURCE must be one of: candle, chainlink, binance, auto");
  }

  if (this.candlePollIntervalMs < 2000 || this.candlePollIntervalMs > 30000) {
    throw new Error("CANDLE_POLL_INTERVAL_MS must satisfy 2000 <= value <= 30000");
  }

  if (this.candleStaleMs < 5000 || this.candleStaleMs > 60000) {
    throw new Error("CANDLE_STALE_MS must satisfy 5000 <= value <= 60000");
  }

  if (this.priceDriftThresholdUsd < 0) {
    throw new Error("PRICE_DRIFT_THRESHOLD_USD must be >= 0");
  }

  if (this.priceStaleMs < 1000 || this.priceStaleMs > 120000) {
    throw new Error("PRICE_STALE_MS must satisfy 1000 <= value <= 120000");
  }

  if (this.roundVolBlend < 0 || this.roundVolBlend > 1) {
    throw new Error("ROUND_VOL_BLEND must satisfy 0 <= value <= 1");
  }

  if (this.roundVolFloorMultiplier < 0 || this.roundVolFloorMultiplier > 2) {
    throw new Error("ROUND_VOL_FLOOR_MULTIPLIER must satisfy 0 <= value <= 2");
  }

  if (this.volRegimeLookback < 10 || this.volRegimeLookback > 1000) {
    throw new Error("VOL_REGIME_LOOKBACK must satisfy 10 <= value <= 1000");
  }

  if (this.volHighMultiplier <= 1 || this.volHighMultiplier > 10) {
    throw new Error("VOL_HIGH_MULTIPLIER must satisfy 1 < value <= 10");
  }

  if (this.volLowMultiplier <= 0 || this.volLowMultiplier >= 1) {
    throw new Error("VOL_LOW_MULTIPLIER must satisfy 0 < value < 1");
  }

  if (this.volHighEdgeFactor <= 0 || this.volHighEdgeFactor > 2) {
    throw new Error("VOL_HIGH_EDGE_FACTOR must satisfy 0 < value <= 2");
  }

  if (this.volLowEdgeFactor <= 0 || this.volLowEdgeFactor > 2) {
    throw new Error("VOL_LOW_EDGE_FACTOR must satisfy 0 < value <= 2");
  }

  if (!["FOK", "FAK"].includes(this.executionOrderType)) {
    throw new Error("EXECUTION_ORDER_TYPE must be FOK or FAK");
  }

  if (this.executionMaxRepriceSteps < 0 || this.executionMaxRepriceSteps > 5) {
    throw new Error("EXECUTION_MAX_REPRICE_STEPS must satisfy 0 <= value <= 5");
  }

  if (this.executionRepriceStep < 0 || this.executionRepriceStep > 0.1) {
    throw new Error("EXECUTION_REPRICE_STEP must satisfy 0 <= value <= 0.1");
  }

  if (this.executionPriceBuffer < 0 || this.executionPriceBuffer > 0.1) {
    throw new Error("EXECUTION_PRICE_BUFFER must satisfy 0 <= value <= 0.1");
  }

  if (this.minLiveFillUsdc < 0) {
    throw new Error("MIN_LIVE_FILL_USDC must be >= 0");
  }

  if (this.minPositionSizeUsdc <= 0 || this.maxPositionSizeUsdc <= 0 || this.minPositionSizeUsdc > this.maxPositionSizeUsdc) {
    throw new Error("MIN_POSITION_SIZE_USDC/MAX_POSITION_SIZE_USDC must satisfy 0 < min <= max");
  }

  if (this.lateWindowMinTimeSec < 0 || this.lateWindowMaxTimeSec < 0 || this.lateWindowMinTimeSec > this.lateWindowMaxTimeSec) {
    throw new Error("LATE_WINDOW_MIN_TIME_SEC/LATE_WINDOW_MAX_TIME_SEC must satisfy 0 <= min <= max");
  }

  if (this.lateWindowEdgeThreshold < 0 || this.lateWindowEdgeThreshold >= 1) {
    throw new Error("LATE_WINDOW_EDGE_THRESHOLD must satisfy 0 <= value < 1");
  }

  if (this.lateWindowMinNetEdge < 0 || this.lateWindowMinNetEdge >= 1) {
    throw new Error("LATE_WINDOW_MIN_NET_EDGE must satisfy 0 <= value < 1");
  }

  if (this.lateWindowMaxEntryPrice <= 0 || this.lateWindowMaxEntryPrice >= 1) {
    throw new Error("LATE_WINDOW_MAX_ENTRY_PRICE must satisfy 0 < value < 1");
  }

  if (this.chainlinkConfirmBoost < 0 || this.chainlinkConfirmBoost >= 0.2) {
    throw new Error("CHAINLINK_CONFIRM_BOOST must satisfy 0 <= value < 0.2");
  }

  if (this.chainlinkConflictPull < 0 || this.chainlinkConflictPull > 1) {
    throw new Error("CHAINLINK_CONFLICT_PULL must satisfy 0 <= value <= 1");
  }

  if (this.combinedArbMinNetPerShare < 0 || this.combinedArbMinNetPerShare >= 1) {
    throw new Error("COMBINED_ARB_MIN_NET_PER_SHARE must satisfy 0 <= value < 1");
  }

  if (this.combinedArbMaxUsdc <= 0) {
    throw new Error("COMBINED_ARB_MAX_USDC must be > 0");
  }

  if (this.feeRateBps < 0 || this.feeRateBps > 5000) {
    throw new Error("FEE_RATE_BPS must satisfy 0 <= value <= 5000");
  }

  if (this.autoClaimEnabled && !this.paperTrade && (this.signatureType === 1 || this.signatureType === 2)) {
    const hasRemote = !!this.builderSignerUrl;
    const hasLocal =
      !!this.polyBuilderApiKey &&
      !!this.polyBuilderSecret &&
      !!this.polyBuilderPassphrase;
    if (!hasRemote && !hasLocal) {
      throw new Error(
        "AUTO_CLAIM_ENABLED with SIGNATURE_TYPE 1/2 requires builder auth (remote signer or POLY_BUILDER_* creds)"
      );
    }
  }
};

module.exports = config;
