# Kamino Positions Monitor

A Node.js tool to monitor Solana wallets with Kamino Lend positions. It generates a liquidation-focused report with collateral, debt, health metrics, liquidation prices, and actionable recommendations (how much to deposit or repay to reach a target health level).

## What It Does

- **Spot balances**: Fetches SOL, USDC, USDT balances from the Solana blockchain via RPC
- **Kamino positions**: Gets lending obligations from Kamino's REST API (no RPC for this, avoids rate limits)
- **Health metrics**: Computes health in two scales (ratio and percentage) with liquidation risk indicators
- **Liquidation price**: Estimates SOL price at which positions would be liquidated (assumes SOL-correlated collateral)
- **Actionables**: Calculates how much to deposit (in USD/SOL) or repay to reach 60% health margin
- **Scenario analysis**: Shows impact if SOL drops 10%, 20%, or 30%
- **Telegram**: Optionally sends the report via Telegram with HTML formatting (bold, links)

## Data Sources

| Data              | Source                                              |
|-------------------|-----------------------------------------------------|
| Spot balances     | Solana RPC (`getMultipleAccountsInfo`)              |
| Kamino obligations| [Kamino REST API](https://api.kamino.finance)       |
| SOL price         | [CoinGecko API](https://api.coingecko.com)         |

## How Values Are Calculated

### Health

- **Health ratio** = `borrowLiquidationLimit / totalBorrow`
  - `1.0` = at liquidation threshold
  - `> 1` = safe margin
- **Health %** = `100 × (health - 1) / health`
  - `0%` = liquidation
  - `100%` = maximum margin

### SOL Liquidation Price

Assumes collateral is SOL-correlated (mSOL, jitoSOL, bSOL, etc.):

```
P_liq = P_now × (debt / (liquidationLtv × collateral))
```

### Deposit to Reach 60% Health

Target health ratio = 2.5 (equivalent to 60% margin):

```
collateral_needed = 2.5 × debt / liquidationLtv
deposit = collateral_needed - current_collateral
```

### Repay for Same Effect

```
repay = debt - (collateral × liquidationLtv) / 2.5
```

### Impact of SOL Price Drop

When SOL drops X%, collateral value falls proportionally:

```
collateral_new = collateral × (1 - X/100)
deposit_needed = (2.5 × debt / liqLtv) - collateral_new
repay_needed = debt - (collateral_new × liqLtv) / 2.5
```

## Setup

### 1. Install

```bash
npm install
```

### 2. Configure

Copy the example files and fill in your values:

```bash
cp .env.example .env
cp wallets.json.example wallets.json
```

**`.env`** (all optional): If `SOLANA_RPC_URL` is not set, the public Solana mainnet RPC is used (rate-limited; for heavy use, get a free RPC at [Alchemy](https://alchemy.com) or [QuickNode](https://quicknode.com)):

```
# SOLANA_RPC_URL=https://your-rpc-url.here   # optional
# TELEGRAM_BOT_TOKEN=your_bot_token          # optional
# TELEGRAM_CHAT_ID=your_chat_id              # optional
```

**`wallets.json`**:

```json
{
  "wallets": [
    { "name": "Fund 1", "address": "YourSolanaWalletAddress1" },
    { "name": "Fund 2", "address": "YourSolanaWalletAddress2" }
  ],
  "thresholds": { "green": 1.6, "yellow": 1.35, "orange": 1.2 },
  "onlyMainMarket": true,
  "walletDelayMs": 300
}
```

- **wallets**: Array of `{ name, address }` for wallets to monitor
- **thresholds**: Health ratio thresholds for emoji indicators (🟢🟡🟠🔴)
- **onlyMainMarket**: If `true`, only queries Kamino Main Market (recommended to avoid rate limits)
- **walletDelayMs**: Delay between wallet queries to avoid rate limits

### 3. Telegram (Optional, for direct runs only)

When running the script directly (not via OpenClaw), you can push the report to a Telegram chat. Via OpenClaw, the agent delivers it to your chat automatically—no Telegram config needed.

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Get your chat ID (e.g. via [@userinfobot](https://t.me/userinfobot))
3. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to `.env`

## Usage

```bash
# Use default wallets.json
npm run monitor

# Or specify config file
node kamino_monitor.js path/to/wallets.json
```

Output goes to stdout. When run via OpenClaw, the agent delivers the report to your chat. When run directly (cron, terminal), optional `TELEGRAM_*` in `.env` also pushes to a Telegram chat (HTML formatting, Jupiter links).

## OpenClaw Skill

Use this monitor as an [OpenClaw](https://openclaw.ai) skill so your agent can run it on request.

**Prerequisite:** You need the full project (this repo) installed and configured—the skill tells the agent how to run the script, but the script lives here.

**Install the skill** (pick one):

1. **From this repo** (after cloning and completing Setup above):
   ```bash
   cp -r openclaw-skill ~/.openclaw/skills/kamino-positions-monitor
   ```

2. **From ClawHub** (once published): `clawhub install kamino-positions-monitor`  
   You still need to clone this repo and configure it—the skill alone does not include the monitor script.

**Run:** Open OpenClaw from this project directory, or set `KAMINO_MONITOR_PATH` to the project path. Then ask: "Run the Kamino positions monitor" or "Check my Kamino liquidation risk".

## Security

- **Never commit** `.env` or `wallets.json` (they are in `.gitignore`)
- Use `wallets.json.example` and `.env.example` as templates only
- RPC URL and wallet addresses are sensitive; keep them out of version control

## License

ISC
