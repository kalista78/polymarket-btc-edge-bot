const { Wallet } = require("@ethersproject/wallet");
const config = require("../config");
const log = require("../utils/logger");

const TAG = "ORDER";

let sdkState = null;
let warnedLiveDisabled = false;

async function buildBuilderConfig() {
  const hasRemote = !!config.builderSignerUrl;
  const hasLocal =
    !!config.polyBuilderApiKey &&
    !!config.polyBuilderSecret &&
    !!config.polyBuilderPassphrase;

  if (!hasRemote && !hasLocal) return undefined;

  const { BuilderConfig } = await import("@polymarket/builder-signing-sdk");
  if (hasRemote) {
    return new BuilderConfig({
      remoteBuilderConfig: {
        url: config.builderSignerUrl,
        token: config.builderSignerToken || undefined,
      },
    });
  }

  return new BuilderConfig({
    localBuilderCreds: {
      key: config.polyBuilderApiKey,
      secret: config.polyBuilderSecret,
      passphrase: config.polyBuilderPassphrase,
    },
  });
}

function shortAddress(addr = "") {
  if (!addr || addr.length < 12) return addr || "n/a";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

async function loadClient() {
  if (sdkState) return sdkState;

  const sdk = await import("@polymarket/clob-client");
  const wallet = new Wallet(config.privateKey);
  const builderConfig = await buildBuilderConfig();
  const creds = {
    key: config.apiKey,
    secret: config.apiSecret,
    passphrase: config.apiPassphrase,
  };

  const chain = Number(config.chainId) === Number(sdk.Chain.AMOY)
    ? sdk.Chain.AMOY
    : sdk.Chain.POLYGON;

  const client = new sdk.ClobClient(
    config.clobBaseUrl,
    chain,
    wallet,
    creds,
    config.signatureType,
    config.funderAddress || wallet.address,
    undefined,
    true, // Use CLOB server time for request signing.
    builderConfig
  );

  const builderType = builderConfig?.getBuilderType
    ? builderConfig.getBuilderType()
    : "UNAVAILABLE";
  sdkState = { sdk, wallet, client, builderType };
  return sdkState;
}

/**
 * Runs a non-trading connectivity/auth preflight for live mode.
 */
async function runLivePreflight() {
  if (config.paperTrade) {
    return {
      ok: false,
      mode: "paper",
      reason: "PAPER_TRADE=true (switch to PAPER_TRADE=false for live preflight)",
    };
  }

  const report = {
    ok: false,
    mode: "live",
    checks: {},
  };

  try {
    // Helpful signal about current node geolocation when running from VPS/server.
    try {
      const geoRes = await fetch("https://polymarket.com/api/geoblock");
      const geo = await geoRes.json();
      report.checks.geoblock = geo;
    } catch (err) {
      report.checks.geoblock = { error: err.message };
    }

    const { sdk, wallet, client, builderType } = await loadClient();
    report.checks.signer = wallet.address;
    report.checks.funder = config.funderAddress || wallet.address;
    report.checks.signatureType = config.signatureType;
    report.checks.chainId = config.chainId;
    report.checks.builderSigning = {
      type: builderType,
      remoteSigner: !!config.builderSignerUrl,
      localCreds: !!(
        config.polyBuilderApiKey &&
        config.polyBuilderSecret &&
        config.polyBuilderPassphrase
      ),
    };

    const serverTime = await client.getServerTime();
    report.checks.serverTime = serverTime;

    const closedOnly = await client.getClosedOnlyMode();
    report.checks.closedOnlyMode = closedOnly;

    const collateral = await client.getBalanceAllowance({
      asset_type: sdk.AssetType.COLLATERAL,
    });
    report.checks.collateral = collateral;

    report.ok = true;
    return report;
  } catch (err) {
    report.error = err.message;
    return report;
  }
}

/**
 * Fetches live collateral cash balance (USDC) from CLOB.
 * Returns null when unavailable.
 */
async function getLiveCollateralUsdc() {
  if (config.paperTrade) return null;

  try {
    const { sdk, client } = await loadClient();
    const collateral = await client.getBalanceAllowance({
      asset_type: sdk.AssetType.COLLATERAL,
    });
    const raw = Number(collateral?.balance);
    if (!Number.isFinite(raw)) return null;
    return raw / 1_000_000;
  } catch (err) {
    log.warn(TAG, `Collateral fetch failed: ${err.message}`);
    return null;
  }
}

function parsePositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeStatus(statusRaw) {
  return String(statusRaw || "").toLowerCase();
}

function parseConditionalAllowanceShares(response) {
  const direct = Number(response?.allowance);
  if (Number.isFinite(direct) && direct >= 0) {
    return direct / 1_000_000;
  }

  const allowances = response?.allowances;
  if (allowances && typeof allowances === "object") {
    const values = Object.values(allowances)
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v >= 0);
    if (values.length > 0) {
      return Math.max(...values) / 1_000_000;
    }
  }

  return 0;
}

function inferFillFromResponse(data, { amount, expectedShares, expectedPrice }) {
  const rawA = Number(data?.takingAmount);
  const rawB = Number(data?.makingAmount);
  if (!Number.isFinite(rawA) || !Number.isFinite(rawB) || rawA <= 0 || rawB <= 0) return null;

  const normalizers = [1, 1_000_000];
  let best = null;

  for (const usdcScale of normalizers) {
    for (const shareScale of normalizers) {
      const asUsdc = rawA / usdcScale;
      const asShares = rawB / shareScale;
      if (asUsdc > 0 && asShares > 0) {
        const price = asUsdc / asShares;
        if (price > 0 && price < 1) {
          const usdcScore = Math.abs(asUsdc - amount);
          const shareScore = Math.abs(asShares - expectedShares);
          const priceScore = Math.abs(price - expectedPrice);
          const score = usdcScore + shareScore + (priceScore * amount);
          if (!best || score < best.score) {
            best = {
              score,
              filledUsdc: asUsdc,
              filledShares: asShares,
              filledPrice: price,
            };
          }
        }
      }

      const bsUsdc = rawB / usdcScale;
      const bsShares = rawA / shareScale;
      if (bsUsdc > 0 && bsShares > 0) {
        const price = bsUsdc / bsShares;
        if (price > 0 && price < 1) {
          const usdcScore = Math.abs(bsUsdc - amount);
          const shareScore = Math.abs(bsShares - expectedShares);
          const priceScore = Math.abs(price - expectedPrice);
          const score = usdcScore + shareScore + (priceScore * amount);
          if (!best || score < best.score) {
            best = {
              score,
              filledUsdc: bsUsdc,
              filledShares: bsShares,
              filledPrice: price,
            };
          }
        }
      }
    }
  }

  if (!best) return null;
  if (best.filledUsdc <= 0 || best.filledShares <= 0) return null;
  if (best.filledUsdc > amount * 2.5) return null;
  if (best.filledShares > expectedShares * 3) return null;
  return {
    source: "response_amounts",
    status: data?.status || null,
    filledUsdc: best.filledUsdc,
    filledShares: best.filledShares,
    filledPrice: best.filledPrice,
  };
}

async function fetchLiveFill(client, { orderId, tokenId }) {
  if (!orderId) return null;

  // First try order summary.
  for (let i = 0; i < 2; i++) {
    try {
      const order = await client.getOrder(orderId);
      const filledShares = parsePositiveNumber(order?.size_matched);
      const filledPrice = parsePositiveNumber(order?.price);
      if (filledShares && filledPrice) {
        return {
          source: "order",
          status: order?.status || null,
          filledShares,
          filledPrice,
          filledUsdc: filledShares * filledPrice,
        };
      }
    } catch (err) {
      log.debug(TAG, `getOrder(${orderId}) fill lookup failed: ${err.message}`);
    }

    if (i === 0) {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  // Fallback: aggregate recent trades for this taker order.
  try {
    const trades = await client.getTrades({ asset_id: tokenId }, true);
    const mine = (Array.isArray(trades) ? trades : []).filter((t) => t?.taker_order_id === orderId);
    if (!mine.length) return null;

    let shares = 0;
    let usdc = 0;
    for (const t of mine) {
      const size = Number(t?.size);
      const price = Number(t?.price);
      if (!Number.isFinite(size) || !Number.isFinite(price) || size <= 0 || price <= 0) continue;
      shares += size;
      usdc += size * price;
    }
    if (shares > 0 && usdc > 0) {
      return {
        source: "trades",
        status: mine[0]?.status || null,
        filledShares: shares,
        filledPrice: usdc / shares,
        filledUsdc: usdc,
      };
    }
  } catch (err) {
    log.debug(TAG, `getTrades fill lookup failed: ${err.message}`);
  }

  return null;
}

/**
 * Place a live/paper order for an outcome token using official CLOB client.
 *
 * @param {object} params
 * @param {string} params.tokenId
 * @param {number} params.price
 * @param {number} [params.maxPrice]
 * @param {number} params.size
 * @param {number} [params.usdcAmount]
 * @param {string} params.side
 * @param {"BUY"|"SELL"} [params.orderSide]
 * @param {"FOK"|"FAK"} [params.orderTypeOverride]
 * @returns {object|null}
 */
async function placeOrder({
  tokenId,
  price,
  maxPrice,
  size,
  usdcAmount,
  side,
  orderSide = "BUY",
  orderTypeOverride,
}) {
  const isSell = String(orderSide || "BUY").toUpperCase() === "SELL";
  const verb = isSell ? "sell" : "buy";
  if (config.paperTrade) {
    const paperUsdc = price * size;
    log.trade(TAG, `[PAPER] Would ${verb} ${side}`, {
      token: tokenId.slice(0, 12) + "...",
      price: price.toFixed(3),
      shares: size.toFixed(2),
      usdc: `$${paperUsdc.toFixed(2)}`,
    });
    return {
      paper: true,
      side,
      orderSide: isSell ? "SELL" : "BUY",
      price,
      size,
      filledShares: size,
      filledPrice: price,
      filledUsdc: paperUsdc,
      fillRatio: 1,
      fillSource: "paper",
      orderTypeUsed: "PAPER",
      limitPriceUsed: price,
    };
  }

  if (!config.enableLiveOrders) {
    if (!warnedLiveDisabled) {
      warnedLiveDisabled = true;
      log.warn(
        TAG,
        "LIVE MODE is active but real order submission is disabled (set ENABLE_LIVE_ORDERS=true and LIVE_ACKNOWLEDGE)."
      );
    }
    return { skipped: true, reason: "live_orders_disabled" };
  }

  try {
    const { sdk, client, wallet, builderType } = await loadClient();
    let amount = isSell
      ? size
      : (Number.isFinite(usdcAmount) && usdcAmount > 0 ? usdcAmount : (price * size));

    if (isSell) {
      let conditional = await client.getBalanceAllowance({
        asset_type: sdk.AssetType.CONDITIONAL,
        token_id: tokenId,
      });
      let balanceShares = Number(conditional?.balance) / 1_000_000;
      let allowanceShares = parseConditionalAllowanceShares(conditional);

      if (!Number.isFinite(allowanceShares) || allowanceShares <= 0) {
        try {
          await client.updateBalanceAllowance({
            asset_type: sdk.AssetType.CONDITIONAL,
            token_id: tokenId,
          });
          conditional = await client.getBalanceAllowance({
            asset_type: sdk.AssetType.CONDITIONAL,
            token_id: tokenId,
          });
          balanceShares = Number(conditional?.balance) / 1_000_000;
          allowanceShares = parseConditionalAllowanceShares(conditional);
        } catch (err) {
          log.warn(TAG, `Conditional allowance update failed: ${err.message}`);
        }
      }

      const availableShares = Math.max(
        0,
        Math.min(
          Number.isFinite(balanceShares) ? balanceShares : 0,
          Number.isFinite(allowanceShares) ? allowanceShares : 0
        )
      );
      const requestedShares = Number.isFinite(amount) ? amount : 0;
      // CLOB rounds sell size to 2dp; floor conservatively against current available balance.
      const sellableShares = Math.floor(Math.max(0, Math.min(requestedShares, availableShares) - 1e-8) * 100) / 100;
      if (!Number.isFinite(sellableShares) || sellableShares <= 0) {
        return {
          skipped: true,
          reason: "no_token_balance",
          availableShares,
          requestedShares,
          allowanceShares,
          balanceShares,
        };
      }
      if (sellableShares + 1e-9 < requestedShares) {
        log.warn(
          TAG,
          `Reducing sell size to available balance: requested=${requestedShares.toFixed(4)} available=${availableShares.toFixed(4)} sell=${sellableShares.toFixed(2)}`
        );
      }
      amount = sellableShares;
    }
    const selectedOrderType = String(orderTypeOverride || config.executionOrderType || "FAK").toUpperCase();
    const orderType = sdk.OrderType[selectedOrderType] || sdk.OrderType.FAK;
    const boundedPrice = Math.max(0.001, Math.min(price, 0.999));
    const boundedLimit = Number.isFinite(maxPrice) && maxPrice > 0
      ? Math.max(0.001, Math.min(maxPrice, 0.999))
      : boundedPrice;
    const attempts = [];

    for (let step = 0; step <= config.executionMaxRepriceSteps; step++) {
      const rawStepPrice = isSell
        ? (boundedPrice - step * config.executionRepriceStep)
        : (boundedPrice + step * config.executionRepriceStep);
      const limitPrice = isSell
        ? Math.max(0.001, Math.min(boundedLimit, rawStepPrice))
        : Math.max(0.001, Math.min(boundedLimit, rawStepPrice));
      if (attempts.length > 0 && Math.abs(limitPrice - attempts[attempts.length - 1].limitPrice) < 1e-9) {
        continue;
      }

      log.trade(TAG, `LIVE ORDER: ${isSell ? "SELL" : "BUY"} ${side}`, {
        token: tokenId.slice(0, 12) + "...",
        signer: shortAddress(wallet.address),
        funder: shortAddress(config.funderAddress || wallet.address),
        amount: isSell ? `${amount.toFixed(4)} shares` : `$${amount.toFixed(2)}`,
        limitPrice: limitPrice.toFixed(3),
        estShares: size.toFixed(4),
        type: selectedOrderType,
        attempt: `${step + 1}/${config.executionMaxRepriceSteps + 1}`,
        builderSigning: builderType,
      });

      const data = await client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount: +amount.toFixed(4),
          side: isSell ? sdk.Side.SELL : sdk.Side.BUY,
          orderType,
          price: +limitPrice.toFixed(4),
        },
        undefined,
        orderType
      );

      const orderId = data?.orderID || data?.id || data?.orderId || null;
      const statusRaw = data?.status;
      const status = normalizeStatus(statusRaw);
      const errorMsg = data?.error || data?.errorMsg;
      const hasError = !!errorMsg;
      const acceptedStatuses = new Set(["matched", "partially_matched", "filled", "live"]);
      const accepted = acceptedStatuses.has(status);

      attempts.push({
        limitPrice,
        status: statusRaw || "unknown",
        orderId,
        error: errorMsg || null,
      });

      log.trade(TAG, `LIVE ORDER RESULT: ${statusRaw || "unknown"}`, {
        orderId,
        takingAmount: data?.takingAmount,
        makingAmount: data?.makingAmount,
        error: errorMsg,
      });

      if (hasError || (!accepted && !orderId)) {
        const canRetry = step < config.executionMaxRepriceSteps;
        if (!canRetry) {
          log.warn(TAG, `Live order not accepted by exchange: ${errorMsg || statusRaw || "unknown"}`);
          return {
            skipped: true,
            reason: hasError ? "order_rejected" : "order_unaccepted",
            data,
            attempts,
          };
        }
        continue;
      }

      const fill =
        (await fetchLiveFill(client, { orderId, tokenId })) ||
        inferFillFromResponse(data, {
          amount,
          expectedShares: size,
          expectedPrice: limitPrice,
        });
      const filledShares = fill?.filledShares || size;
      const filledPrice = fill?.filledPrice || limitPrice;
      const filledUsdc = fill?.filledUsdc || (filledShares * filledPrice);
      const fillRatioBase = isSell ? amount : (Number.isFinite(amount) ? amount : 0);
      const fillRatio = fillRatioBase > 0
        ? Math.max(0, Math.min(1, (isSell ? filledShares : filledUsdc) / fillRatioBase))
        : 0;

      if (!fill && status === "live") {
        const canRetry = step < config.executionMaxRepriceSteps;
        if (!canRetry) {
          return {
            skipped: true,
            reason: "unfilled_live_order",
            data,
            orderId,
            attempts,
          };
        }
        continue;
      }

      if (filledUsdc < config.minLiveFillUsdc) {
        const canRetry = step < config.executionMaxRepriceSteps;
        if (!canRetry) {
          return {
            skipped: true,
            reason: "insufficient_fill",
            data,
            orderId,
            attempts,
            filledUsdc,
            filledShares,
          };
        }
        continue;
      }

      return {
        paper: false,
        orderId,
        data,
        attempts,
        orderSide: isSell ? "SELL" : "BUY",
        orderTypeUsed: selectedOrderType,
        limitPriceUsed: limitPrice,
        filledShares,
        filledPrice,
        filledUsdc,
        fillRatio,
        fillSource: fill?.source || "fallback",
        orderStatus: fill?.status || statusRaw || "unknown",
      };
    }

    return {
      skipped: true,
      reason: "order_unaccepted",
      attempts,
    };
  } catch (err) {
    log.error(TAG, `Live order failed: ${err.message}`);
    return null;
  }
}

module.exports = { placeOrder, runLivePreflight, getLiveCollateralUsdc };
