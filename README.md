# Polymarket BTC Edge Bot

High-discipline Polymarket BTC 5-minute trading bot with paper/live modes, adaptive sizing, and strict risk guardrails.

This bot targets short-lived mispricings between model-estimated fair probability and live Polymarket order books.

## What It Does

- Tracks the active BTC 5m market window on Polymarket.
- Builds a fair value estimate for Up/Down using a GBM-style probability model.
- Compares fair value to real book prices including fee and slippage assumptions.
- Trades only when edge, depth, spread, and risk constraints all pass.
- Supports paper mode by default, with explicit controls for live execution.
- Provides Telegram monitoring and control commands.

## Strategy Summary

The core probability engine computes:

`z = (ln(S/S0) + (mu - 0.5*sigma^2)*t) / (sigma*sqrt(t))`

Then:

- `pUp = Phi(z)` (normal CDF)
- Probability is shrunk toward 0.5 (`PROBABILITY_SHRINK`) for conservatism.
- Optional Chainlink confirmation can slightly boost or pull confidence.

Entry candidates are evaluated on real order book fill quality:

- VWAP-based fill estimate
- Fee + slippage adjusted cost
- Net edge and expected PnL thresholds
- Spread, depth, and price-band filters

## Risk Guardrails

- `MAX_DAILY_LOSS_USDC` daily lockout.
- `MAX_ROUND_LOSS_USDC` per-window risk cap.
- `MAX_CONCURRENT_POSITIONS` cap on open exposure.
- Same-side re-entry spacing and stricter repeat-entry criteria.
- Live run caps via `LIVE_MAX_TRADES_PER_RUN` and `LIVE_MAX_NOTIONAL_USDC`.
- Hard live arm requirements:
  - `PAPER_TRADE=false`
  - `ENABLE_LIVE_ORDERS=true`
  - `LIVE_ACKNOWLEDGE=I_UNDERSTAND_REAL_TRADES`

## Repository Layout

- `src/index.js`: main loop, orchestration, risk checks, execution flow.
- `src/strategy/fair-value.js`: probability model.
- `src/strategy/edge-detector.js`: edge math and trade gating.
- `src/feeds/`: market data / price tracking.
- `src/execution/`: discovery, order books, order placement, claims.
- `src/integrations/telegram.js`: Telegram control and notifications.
- `live-preflight.js`: safe connectivity and account readiness checks.

## Quickstart

### 1. Install

```bash
npm install
```

### 2. Configure env

```bash
cp .env.example .env
```

Fill required values in `.env` (especially API credentials for live mode).

### 3. Run in paper mode (default and recommended first)

```bash
npm run paper
```

### 4. Run live preflight (no order submission)

```bash
npm run live-preflight
```

Expected output ends with: `Preflight passed.`

### 5. Arm live mode (only when ready)

Set in `.env`:

```env
PAPER_TRADE=false
ENABLE_LIVE_ORDERS=true
LIVE_ACKNOWLEDGE=I_UNDERSTAND_REAL_TRADES
```

Then run:

```bash
npm run live
```

## Scripts

- `npm start`: run bot with current `.env`.
- `npm run paper`: force paper mode.
- `npm run live`: force live mode.
- `npm run live-preflight`: auth/connectivity/market readiness check.
- `npm run debug`: verbose logging.
- `npm run measure-latency`: latency utility.
- `npm run measure-ratelimits`: API rate-limit utility.
- `npm run analyze-paper`: analyze paper trade history.

## Docker

Build and run:

```bash
docker compose up --build -d
```

The bot persists data in `./data` (mounted to `/app/data` in container).

## Telegram Controls (Optional)

Set:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID` (or `TELEGRAM_ALLOW_FIRST_CHAT=true`)

Commands:

- `/status`
- `/balance`
- `/stop`
- `/resume`
- `/claim`
- `/help`

## Operational Notes

- Use a dedicated low-balance bot wallet, never your primary wallet.
- Keep `PRICE_SOURCE=candle` for closest settlement alignment.
- Start with smaller `POSITION_SIZE_USDC` and strict risk caps.
- Keep secrets only in `.env` and never commit credential-bearing files.
- Backup files like `.env.bak*` are ignored; still treat them as sensitive.

## Security and Disclosure

- This project was scanned for secrets before open-sourcing.
- `.env` and backup env files are gitignored.
- If you discover a vulnerability or accidental secret exposure, rotate keys immediately and open a security issue or private report.

## Disclaimer

This software is experimental and provided as-is. Trading involves real financial risk, including total loss. You are responsible for your own configuration, key management, and execution decisions.

