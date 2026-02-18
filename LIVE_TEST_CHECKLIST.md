# Live Test Checklist (100 USDC)

## 1) Configure `.env`
Set these fields before tomorrow's test:

```env
PAPER_TRADE=false
ENABLE_LIVE_ORDERS=false
LIVE_ACKNOWLEDGE=

PRIVATE_KEY=...
POLY_API_KEY=...
POLY_SECRET=...
POLY_PASSPHRASE=...

# Proxy/gas-sponsored flow
SIGNATURE_TYPE=1
FUNDER_ADDRESS=0x...
CHAIN_ID=137

# Optional for builder/relayer path (recommended via remote signer)
BUILDER_SIGNER_URL=
BUILDER_SIGNER_TOKEN=
# OR local builder credentials (all 3)
POLY_BUILDER_API_KEY=
POLY_BUILDER_SECRET=
POLY_BUILDER_PASSPHRASE=

# Risk limits
POSITION_SIZE_USDC=5
LIVE_MAX_TRADES_PER_RUN=8
LIVE_MAX_NOTIONAL_USDC=100
```

## 2) Run preflight (safe, no order submission)

```bash
npm run live-preflight
```

Expected: `Preflight passed.`

## 3) Fund the profile

- Fund `FUNDER_ADDRESS` with at least `100 USDC` on Polygon.
- Keep `ENABLE_LIVE_ORDERS=false` until preflight is green.

## Security baseline (strongly recommended)

- Do not use your main wallet private key in the bot.
- Create a dedicated bot signer wallet with only small operating funds.
- Keep only the amount you are willing to trade in the bot funder/profile.

## Telegram monitoring/control (optional)

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_ALLOW_FIRST_CHAT=false
TELEGRAM_NOTIFY_ENTRIES=true
TELEGRAM_NOTIFY_RESOLUTIONS=true
STARTING_BALANCE_USDC=100
```

- Commands: `/status`, `/balance`, `/stop` (pause entries), `/resume`, `/help`.

## 4) Arm real trading

Update `.env`:

```env
ENABLE_LIVE_ORDERS=true
LIVE_ACKNOWLEDGE=I_UNDERSTAND_REAL_TRADES
```

Then start:

```bash
npm run live
```

## 5) Emergency stop

- Fastest stop: `Ctrl+C`
- Hard disable in config: set `ENABLE_LIVE_ORDERS=false`
