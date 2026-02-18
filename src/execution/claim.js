const { Wallet } = require("@ethersproject/wallet");
const config = require("../config");
const log = require("../utils/logger");

const TAG = "CLAIM";

const CTF_CONTRACT = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const USDC_CONTRACT = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

const CTF_REDEEM_ABI = [
  {
    constant: false,
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    name: "redeemPositions",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
  },
];

const NEG_RISK_REDEEM_ABI = [
  {
    inputs: [
      { internalType: "bytes32", name: "_conditionId", type: "bytes32" },
      { internalType: "uint256[]", name: "_amounts", type: "uint256[]" },
    ],
    name: "redeemPositions",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toTokenRaw(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return 0n;
  return BigInt(Math.round(n * 1_000_000));
}

function normalizeConditionId(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(v)) return null;
  return v;
}

function resolveUserAddress() {
  if (config.funderAddress) return config.funderAddress.toLowerCase();
  try {
    const wallet = new Wallet(config.privateKey);
    return wallet.address.toLowerCase();
  } catch {
    return "";
  }
}

class AutoClaimer {
  constructor({ onClaim } = {}) {
    this.onClaim = typeof onClaim === "function" ? onClaim : null;
    this.timer = null;
    this.inFlight = false;
    this.relayClient = null;
    this.relayerTxType = null;
    this.addr = resolveUserAddress();
    this.recentlyClaimed = new Map(); // conditionId -> ts
  }

  async loadRelayDeps() {
    if (this._deps) return this._deps;
    const viem = await import("viem");
    const accounts = await import("viem/accounts");
    const chains = await import("viem/chains");
    const relayer = await import("@polymarket/builder-relayer-client");
    const builder = await import("@polymarket/builder-signing-sdk");
    this._deps = { viem, accounts, chains, relayer, builder };
    return this._deps;
  }

  async ensureRelayClient() {
    if (this.relayClient) return this.relayClient;

    if (!config.privateKey) {
      throw new Error("PRIVATE_KEY is required for auto-claim");
    }

    if (![1, 2].includes(config.signatureType)) {
      throw new Error("Auto-claim currently supports SIGNATURE_TYPE 1/2 (proxy/safe)");
    }

    const hasRemote = !!config.builderSignerUrl;
    const hasLocal =
      !!config.polyBuilderApiKey &&
      !!config.polyBuilderSecret &&
      !!config.polyBuilderPassphrase;
    if (!hasRemote && !hasLocal) {
      throw new Error("Builder auth is required for relayer claims");
    }

    const { viem, accounts, chains, relayer, builder } = await this.loadRelayDeps();
    const account = accounts.privateKeyToAccount(config.privateKey);
    const walletClient = viem.createWalletClient({
      account,
      chain: Number(config.chainId) === Number(chains.polygonAmoy?.id) ? chains.polygonAmoy : chains.polygon,
      transport: viem.http(config.polygonRpcUrl),
    });

    const builderConfig = hasRemote
      ? new builder.BuilderConfig({
          remoteBuilderConfig: {
            url: config.builderSignerUrl,
            token: config.builderSignerToken || undefined,
          },
        })
      : new builder.BuilderConfig({
          localBuilderCreds: {
            key: config.polyBuilderApiKey,
            secret: config.polyBuilderSecret,
            passphrase: config.polyBuilderPassphrase,
          },
        });

    this.relayerTxType =
      config.signatureType === 1 ? relayer.RelayerTxType.PROXY : relayer.RelayerTxType.SAFE;

    this.relayClient = new relayer.RelayClient(
      config.relayerUrl,
      Number(config.chainId),
      walletClient,
      builderConfig,
      this.relayerTxType
    );

    return this.relayClient;
  }

  async fetchRedeemablePositions() {
    if (!this.addr) return [];
    const params = new URLSearchParams({
      user: this.addr,
      redeemable: "true",
      sizeThreshold: String(config.claimSizeThreshold),
      limit: "500",
      sortBy: "CURRENT_VALUE",
      sortDirection: "DESC",
    });
    const url = `${config.dataApiBaseUrl.replace(/\/$/, "")}/positions?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Data API positions failed: ${res.status}`);
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  }

  buildClaimGroups(positions) {
    const groups = new Map();

    for (const p of positions) {
      const conditionId = normalizeConditionId(p?.conditionId);
      if (!conditionId) continue;

      if (!groups.has(conditionId)) {
        groups.set(conditionId, {
          conditionId,
          title: p?.title || p?.slug || conditionId,
          slug: p?.slug || "",
          negativeRisk: !!p?.negativeRisk,
          currentValue: 0,
          yesRaw: 0n,
          noRaw: 0n,
          count: 0,
        });
      }

      const g = groups.get(conditionId);
      g.count += 1;
      g.currentValue += Number(p?.currentValue || 0) || 0;
      g.negativeRisk = g.negativeRisk || !!p?.negativeRisk;

      const raw = toTokenRaw(p?.size);
      const idx = Number(p?.outcomeIndex);
      if (idx === 0) g.yesRaw += raw;
      else if (idx === 1) g.noRaw += raw;
      else if (String(p?.outcome || "").toLowerCase().includes("yes") || String(p?.outcome || "").toLowerCase().includes("up")) g.yesRaw += raw;
      else if (String(p?.outcome || "").toLowerCase().includes("no") || String(p?.outcome || "").toLowerCase().includes("down")) g.noRaw += raw;
    }

    return [...groups.values()];
  }

  canAttemptCondition(conditionId) {
    const prev = this.recentlyClaimed.get(conditionId);
    if (!prev) return true;
    return Date.now() - prev > 15 * 60 * 1000;
  }

  markAttempted(conditionId) {
    this.recentlyClaimed.set(conditionId, Date.now());
    if (this.recentlyClaimed.size > 200) {
      const entries = [...this.recentlyClaimed.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < entries.length - 200; i++) {
        this.recentlyClaimed.delete(entries[i][0]);
      }
    }
  }

  async buildRedeemTx(group) {
    const { viem } = await this.loadRelayDeps();
    if (group.negativeRisk) {
      if (group.yesRaw <= 0n && group.noRaw <= 0n) return null;
      return {
        to: NEG_RISK_ADAPTER,
        data: viem.encodeFunctionData({
          abi: NEG_RISK_REDEEM_ABI,
          functionName: "redeemPositions",
          args: [group.conditionId, [group.yesRaw, group.noRaw]],
        }),
        value: "0",
      };
    }

    return {
      to: CTF_CONTRACT,
      data: viem.encodeFunctionData({
        abi: CTF_REDEEM_ABI,
        functionName: "redeemPositions",
        args: [USDC_CONTRACT, viem.zeroHash, group.conditionId, [1n, 2n]],
      }),
      value: "0",
    };
  }

  async runOnce(manual = false) {
    if (config.paperTrade || !config.autoClaimEnabled) {
      return { ok: false, skipped: true, reason: "disabled_or_paper", claimed: 0 };
    }
    if (this.inFlight) {
      return { ok: false, skipped: true, reason: "in_flight", claimed: 0 };
    }

    this.inFlight = true;
    try {
      const relay = await this.ensureRelayClient();
      const rows = await this.fetchRedeemablePositions();
      const groups = this.buildClaimGroups(rows).filter((g) => this.canAttemptCondition(g.conditionId));

      if (groups.length === 0) {
        return { ok: true, claimed: 0, totalCandidates: 0, message: "No redeemable positions found." };
      }

      let claimed = 0;
      const txHashes = [];
      let estValue = 0;

      for (const group of groups) {
        const tx = await this.buildRedeemTx(group);
        if (!tx) continue;

        this.markAttempted(group.conditionId);
        const meta = `auto-claim ${group.slug || group.conditionId}`;
        const response = await relay.execute([tx], meta);
        const settled = await response.wait();
        if (settled?.transactionHash) {
          claimed += 1;
          txHashes.push(settled.transactionHash);
          estValue += Math.max(0, Number(group.currentValue || 0));
          log.info(TAG, `Claimed condition ${group.conditionId}`, {
            tx: settled.transactionHash,
            negativeRisk: group.negativeRisk,
            estValue: group.currentValue.toFixed(4),
          });
        } else {
          log.warn(TAG, `Claim did not settle for condition ${group.conditionId}`);
        }
        await sleep(400);
      }

      const message = claimed > 0
        ? `CLAIMED ${claimed} resolved position set(s)\nEstimated claim value: $${estValue.toFixed(2)}\nLast tx: ${txHashes[txHashes.length - 1]}`
        : "Auto-claim scan ran, but no claim tx finalized.";

      if (claimed > 0 && this.onClaim) {
        await this.onClaim(message);
      } else if (manual && this.onClaim) {
        await this.onClaim(message);
      }

      return {
        ok: true,
        claimed,
        totalCandidates: groups.length,
        txHashes,
        estValue,
        message,
      };
    } catch (err) {
      log.warn(TAG, `Auto-claim failed: ${err.message}`);
      if (manual && this.onClaim) {
        await this.onClaim(`CLAIM FAILED\n${err.message}`);
      }
      return { ok: false, error: err.message, claimed: 0 };
    } finally {
      this.inFlight = false;
    }
  }

  start() {
    if (this.timer || config.paperTrade || !config.autoClaimEnabled) return;
    this.timer = setInterval(() => {
      this.runOnce(false).catch((err) => log.warn(TAG, `Claim loop error: ${err.message}`));
    }, config.autoClaimIntervalMs);
    log.info(TAG, `Auto-claim started (interval ${config.autoClaimIntervalMs}ms)`);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { AutoClaimer };

