const log = require("./logger");

const TAG = "STATS";

class Stats {
  constructor() {
    this.trades = [];
    this.dailyPnl = 0;
    this.totalPnl = 0;
    this.wins = 0;
    this.losses = 0;
    this.dayStart = this._todayKey();
  }

  _todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  _resetIfNewDay() {
    const today = this._todayKey();
    if (today !== this.dayStart) {
      log.info(TAG, `New day ${today}, resetting daily P&L (was $${this.dailyPnl.toFixed(2)})`);
      this.dailyPnl = 0;
      this.dayStart = today;
    }
  }

  recordTrade(trade) {
    // trade: { windowTs, side, entryPrice, size, tokenId, timestamp }
    this.trades.push({ ...trade, resolved: false, pnl: null });
    log.trade(TAG, "Trade entered", {
      side: trade.side,
      price: trade.entryPrice,
      size: trade.size,
      window: trade.windowTs,
    });
  }

  resolveTrade(windowTs, won) {
    this._resetIfNewDay();

    const trade = this.trades.find((t) => t.windowTs === windowTs && !t.resolved);
    if (!trade) return;

    trade.resolved = true;
    // If won: payout is size shares at $1 each, cost was entryPrice * size
    // If lost: payout is $0, cost was entryPrice * size
    const cost = trade.entryPrice * trade.size;
    const payout = won ? trade.size : 0;
    trade.pnl = payout - cost;

    this.dailyPnl += trade.pnl;
    this.totalPnl += trade.pnl;
    if (won) this.wins++;
    else this.losses++;

    const emoji = won ? "WIN" : "LOSS";
    log.trade(TAG, `${emoji}: ${trade.side} @ ${trade.entryPrice.toFixed(3)}`, {
      pnl: `$${trade.pnl.toFixed(2)}`,
      dailyPnl: `$${this.dailyPnl.toFixed(2)}`,
      record: `${this.wins}W/${this.losses}L`,
    });
  }

  getDailyPnl() {
    this._resetIfNewDay();
    return this.dailyPnl;
  }

  getOpenPositions() {
    return this.trades.filter((t) => !t.resolved);
  }

  hasTradeForWindow(windowTs) {
    return this.trades.some((t) => t.windowTs === windowTs);
  }

  printSummary() {
    const total = this.wins + this.losses;
    log.info(TAG, "=== Session Summary ===");
    log.info(TAG, `Trades: ${total} (${this.wins}W / ${this.losses}L)`);
    if (total > 0) {
      log.info(TAG, `Win rate: ${((this.wins / total) * 100).toFixed(1)}%`);
    }
    log.info(TAG, `Daily P&L: $${this.dailyPnl.toFixed(2)}`);
    log.info(TAG, `Total P&L: $${this.totalPnl.toFixed(2)}`);
  }
}

module.exports = new Stats();
