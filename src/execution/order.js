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
 * Place a Fill-or-Kill buy order for an outcome token using official CLOB client.
 *
 * @param {object} params
 * @param {string} params.tokenId
 * @param {number} params.price
 * @param {number} params.size
 * @param {number} params.usdcAmount
 * @param {string} params.side
 * @returns {object|null}
 */
async function placeOrder({ tokenId, price, size, usdcAmount, side }) {
  if (config.paperTrade) {
    log.trade(TAG, `[PAPER] Would buy ${side}`, {
      token: tokenId.slice(0, 12) + "...",
      price: price.toFixed(3),
      shares: size.toFixed(2),
      cost: `$${(price * size).toFixed(2)}`,
    });
    return { paper: true, side, price, size };
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
    const amount = Number.isFinite(usdcAmount) && usdcAmount > 0 ? usdcAmount : (price * size);

    log.trade(TAG, `LIVE ORDER: BUY ${side}`, {
      token: tokenId.slice(0, 12) + "...",
      signer: shortAddress(wallet.address),
      funder: shortAddress(config.funderAddress || wallet.address),
      amount: `$${amount.toFixed(2)}`,
      limitPrice: price.toFixed(3),
      estShares: size.toFixed(2),
      type: sdk.OrderType.FOK,
      builderSigning: builderType,
    });

    const data = await client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        amount: +amount.toFixed(4),
        side: sdk.Side.BUY,
        orderType: sdk.OrderType.FOK,
        price: +price.toFixed(4),
      },
      undefined,
      sdk.OrderType.FOK
    );

    const orderId = data?.orderID || data?.id || data?.orderId || null;
    log.trade(TAG, `LIVE ORDER RESULT: ${data?.status || "unknown"}`, {
      orderId,
      takingAmount: data?.takingAmount,
      makingAmount: data?.makingAmount,
    });

    return { paper: false, orderId, data };
  } catch (err) {
    log.error(TAG, `Live order failed: ${err.message}`);
    return null;
  }
}

module.exports = { placeOrder, runLivePreflight };
