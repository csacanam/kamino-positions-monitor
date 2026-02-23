import "dotenv/config";
import fs from "fs";
import path from "path";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";

// ----------- Constants (SPL mints) -----------
const MINTS = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
};

const JUPITER_PORTFOLIO_BASE = "https://jup.ag/portfolio";
const KAMINO_MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const KAMINO_API_BASE = "https://api.kamino.finance";

// ----------- Helpers -----------
function shortAddr(a) {
  if (!a) return "";
  const s = a.toString();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function fmt(n, digits = 4) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "N/A";
  const x = Number(n);
  if (!Number.isFinite(x)) return "N/A";
  // pretty small/large
  if (Math.abs(x) >= 1000) return x.toFixed(2);
  if (Math.abs(x) >= 1) return x.toFixed(2);
  return x.toFixed(digits);
}

function escapeHtml(s) {
  if (typeof s !== "string") return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function riskEmoji(health, t) {
  if (health === null || health === undefined || !Number.isFinite(Number(health))) return "⚪";
  const h = Number(health);
  if (h >= t.green) return "🟢";
  if (h >= t.yellow) return "🟡";
  if (h >= t.orange) return "🟠";
  return "🔴";
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function fetchSolPriceUsd() {
  try {
    const data = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    return Number(data?.solana?.usd ?? 0) || null;
  } catch {
    return null;
  }
}

// ----------- On-chain spot balances (1 RPC call instead of 3) -----------
async function getSpotBalancesBatch(connection, pubkey) {
  const mintUsdc = new PublicKey(MINTS.USDC);
  const mintUsdt = new PublicKey(MINTS.USDT);
  const ataUsdc = getAssociatedTokenAddressSync(mintUsdc, pubkey, false);
  const ataUsdt = getAssociatedTokenAddressSync(mintUsdt, pubkey, false);

  const infos = await connection.getMultipleAccountsInfo([pubkey, ataUsdc, ataUsdt], "confirmed");

  const sol = infos[0] ? infos[0].lamports / LAMPORTS_PER_SOL : 0;
  let usdc = 0,
    usdt = 0;
  try {
    if (infos[1]) usdc = Number(unpackAccount(ataUsdc, infos[1]).amount) / 1e6;
  } catch {
    /* ATA does not exist */
  }
  try {
    if (infos[2]) usdt = Number(unpackAccount(ataUsdt, infos[2]).amount) / 1e6;
  } catch {
    /* ATA does not exist */
  }
  return { sol, usdc, usdt };
}

// ----------- Kamino obligations (REST API - no SDK, no getProgramAccounts) -----------
async function listKaminoMarkets() {
  const data = await fetchJson(`${KAMINO_API_BASE}/v2/kamino-market`);
  const markets = Array.isArray(data) ? data : (data?.markets ?? []);
  return markets
    .map((m) => ({ name: m?.name ?? "Unknown", isPrimary: Boolean(m?.isPrimary), lendingMarket: m?.lendingMarket }))
    .filter((m) => !!m.lendingMarket);
}

/**
 * Gets obligations via Kamino REST API (no RPC, always works).
 * URL: /kamino-market/{marketPubkey}/users/{userPubkey}/obligations
 */
async function getKaminoObligationsViaApi(walletAddress, onlyMainMarket = true) {
  const marketsToQuery = onlyMainMarket
    ? [{ name: "Main Market", lendingMarket: KAMINO_MAIN_MARKET }]
    : await listKaminoMarkets();

  const allObligations = [];
  for (const mc of marketsToQuery) {
    try {
      const url = `${KAMINO_API_BASE}/kamino-market/${mc.lendingMarket}/users/${walletAddress}/obligations`;
      const data = await fetch(url).then((r) => (r.ok ? r.json() : []));
      const obligations = Array.isArray(data) ? data : data?.obligations ?? data?.data ?? [];
      for (const ob of obligations) {
        const stats = ob?.refreshedStats || ob?.state;
        const totalDep = Number(stats?.userTotalDeposit ?? 0) || Number(ob?.state?.depositedValueSf ?? 0) / 1e18;
        const totalBor = Number(stats?.userTotalBorrow ?? 0) || Number(ob?.state?.borrowFactorAdjustedDebtValueSf ?? 0) / 1e18;
        if (totalDep > 0 || totalBor > 0) {
          allObligations.push({ market: mc, obligation: ob });
        }
      }
    } catch {
      continue;
    }
  }
  return allObligations;
}

function summarizeObligationFromApi(obWrap, solPriceUsd = null) {
  const { market, obligation } = obWrap;
  const stats = obligation?.refreshedStats || {};
  const totalCollUsd = Number(stats.userTotalDeposit ?? 0);
  const totalBorrowUsd = Number(stats.userTotalBorrow ?? 0);
  const ltv = Number(stats.loanToValue ?? 0);
  const liquidationLtv = Number(stats.liquidationLtv ?? 0.75);
  const borrowLimit = Number(stats.borrowLimit ?? 0);
  const borrowLiqLimit = Number(stats.borrowLiquidationLimit ?? 0);
  const health = totalBorrowUsd > 0 && borrowLiqLimit > 0 ? borrowLiqLimit / totalBorrowUsd : null;

  // SOL liquidation price (assumes SOL-correlated collateral). P_liq = P_now * debt / (liqLtv * coll)
  let solLiqPrice = null;
  if (solPriceUsd && totalCollUsd > 0 && liquidationLtv > 0 && totalBorrowUsd > 0) {
    solLiqPrice = solPriceUsd * (totalBorrowUsd / (liquidationLtv * totalCollUsd));
  }

  return {
    marketName: market?.name ?? "Market",
    marketKey: market?.lendingMarket ?? "",
    totalCollUsd,
    totalBorrowUsd,
    ltv,
    liquidationLtv,
    health,
    solLiqPrice,
    depositsTop: totalCollUsd > 0 ? [`$${fmt(totalCollUsd, 2)}`] : ["N/A"],
    borrowsTop: totalBorrowUsd > 0 ? [`$${fmt(totalBorrowUsd, 2)}`] : ["N/A"]
  };
}

// ----------- Main -----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const cfgPath = process.argv[2] || "wallets.json";
  const cfg = JSON.parse(fs.readFileSync(path.resolve(cfgPath), "utf8"));

  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const thresholds = cfg.thresholds || { green: 1.6, yellow: 1.35, orange: 1.2 };
  const walletDelayMs = cfg.walletDelayMs ?? 300;
  const onlyMainMarket = cfg.onlyMainMarket ?? true;

  const connection = new Connection(rpcUrl, "confirmed");

  const lines = [];
  const d = new Date();
  const dateStr = d.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });

  const solPriceUsd = await fetchSolPriceUsd();
  const targetHealthPct = 60;
  const targetHealth = 1 / (1 - targetHealthPct / 100);

  // ---- First pass: collect data from all wallets ----
  const walletData = [];
  for (let i = 0; i < cfg.wallets.length; i++) {
    const w = cfg.wallets[i];
    if (i > 0) await sleep(walletDelayMs);

    const pubkey = new PublicKey(w.address);
    const { sol, usdc, usdt } = await getSpotBalancesBatch(connection, pubkey);
    const spotUsd = solPriceUsd ? sol * solPriceUsd + usdc + usdt : null;

    let obligations = [];
    try {
      obligations = await getKaminoObligationsViaApi(w.address, onlyMainMarket);
    } catch {
      obligations = [];
    }

    const summaries = obligations.map((ob) => summarizeObligationFromApi(ob, solPriceUsd));
    const kaminoTotalColl = summaries.reduce((s, x) => s + (x.totalCollUsd ?? 0), 0);
    const kaminoTotalBorrow = summaries.reduce((s, x) => s + (x.totalBorrowUsd ?? 0), 0);
    const s0 = summaries[0];
    const coll = s0?.totalCollUsd ?? 0;
    const debt = s0?.totalBorrowUsd ?? 0;
    const liqLtv = s0?.liquidationLtv || 0.75;
    const collNeeded = debt > 0 ? (targetHealth * debt) / liqLtv : coll;
    const depositUsd = Math.max(0, collNeeded - coll);
    const repayForSameEffect = debt > 0 ? Math.max(0, debt - (coll * liqLtv) / targetHealth) : 0;

    walletData.push({
      w,
      sol,
      usdc,
      usdt,
      spotUsd,
      obligations,
      summaries,
      kaminoTotalColl,
      kaminoTotalBorrow,
      s0,
      depositUsd,
      repayForSameEffect
    });
  }

  // ---- Global totals ----
  const totalColl = walletData.reduce((s, d) => s + d.kaminoTotalColl, 0);
  const totalDebt = walletData.reduce((s, d) => s + d.kaminoTotalBorrow, 0);
  const totalDepositTo60 = walletData.reduce((s, d) => s + d.depositUsd, 0);
  const totalRepayTo60 = walletData.reduce((s, d) => s + d.repayForSameEffect, 0);
  const totalNet = totalColl - totalDebt;
  const worstLiqPrice = walletData
    .filter((d) => d.s0?.solLiqPrice != null && d.s0.solLiqPrice > 0)
    .map((d) => d.s0.solLiqPrice)
    .reduce((a, b) => Math.max(a, b), 0);
  const hasWorstLiq = worstLiqPrice > 0;

  // ---- Output ----
  lines.push(`📊 Funds Report | ${dateStr}`);
  lines.push("");

  // Global summary (liquidation focus)
  lines.push(`📋 GLOBAL SUMMARY`);
  if (solPriceUsd) {
    lines.push(`   SOL price: $${fmt(solPriceUsd, 2)}`);
  }
  lines.push(`   Kamino: Coll $${fmt(totalColl, 0)} | Debt $${fmt(totalDebt, 0)} | Net $${fmt(totalNet, 0)}`);
  if (totalDebt > 0 && solPriceUsd) {
    const totalDepositSol = totalDepositTo60 / solPriceUsd;
    lines.push(`   To bring all to Health 60%: deposit ~$${fmt(totalDepositTo60, 0)} (~${fmt(totalDepositSol, 1)} SOL) or repay ~$${fmt(totalRepayTo60, 0)}`);
  }
  if (hasWorstLiq && solPriceUsd) {
    const distWorst = ((solPriceUsd - worstLiqPrice) / solPriceUsd) * 100;
    lines.push(`   P_liq of fund most at risk: $${fmt(worstLiqPrice, 2)} · SOL must drop ${fmt(distWorst, 1)}% to reach`);
  }
  // Impact if SOL drops: collateral falls X%, to get back to 60% you need more deposit/repay
  const dropScenarios = [10, 20, 30];
  if (totalDebt > 0 && solPriceUsd && walletData.some((d) => d.s0?.totalBorrowUsd > 0)) {
    lines.push(`   If SOL drops:`);
    for (const dropPct of dropScenarios) {
      let depositAtDrop = 0;
      let repayAtDrop = 0;
      for (const d of walletData) {
        const s0 = d.s0;
        if (!s0 || s0.totalBorrowUsd <= 0) continue;
        const coll = s0.totalCollUsd;
        const debt = s0.totalBorrowUsd;
        const liqLtv = s0.liquidationLtv || 0.75;
        const collNew = coll * (1 - dropPct / 100);
        depositAtDrop += Math.max(0, (targetHealth * debt) / liqLtv - collNew);
        repayAtDrop += Math.max(0, debt - (collNew * liqLtv) / targetHealth);
      }
      const extraDep = depositAtDrop - totalDepositTo60;
      const extraRep = repayAtDrop - totalRepayTo60;
      const priceAtDrop = solPriceUsd * (1 - dropPct / 100);
      lines.push(`     ${dropPct}% (SOL ~$${fmt(priceAtDrop, 0)}): deposit $${fmt(depositAtDrop, 0)} total (+$${fmt(extraDep, 0)}) or repay $${fmt(repayAtDrop, 0)} total (+$${fmt(extraRep, 0)})`);
    }
  }
  lines.push("");
  lines.push(`📐 Health in 2 scales:`);
  lines.push(`   • Ratio (e.g. 1.67): debt vs liq limit; 1.0=at edge, >1=safe`);
  lines.push(`   • % (e.g. 40%): margin before liq; 0%=liquidation, 100%=max safe`);
  lines.push("");
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push("");

  // Detail 1-by-1
  for (const d of walletData) {
    const { w, sol, usdc, usdt, spotUsd, obligations, summaries, kaminoTotalColl, kaminoTotalBorrow, s0, depositUsd, repayForSameEffect } = d;
    const kaminoNetUsd = kaminoTotalColl - kaminoTotalBorrow;
    const health = s0?.health;
    const emoji = riskEmoji(health, thresholds);
    const jupLink = `${JUPITER_PORTFOLIO_BASE}/${w.address}`;

    lines.push(`👛 ${w.name} (${shortAddr(w.address)})`);
    const spotTotal = spotUsd !== null ? `$${fmt(spotUsd, 2)}` : "N/A";
    lines.push(`   Spot: SOL ${fmt(sol, 2)} | USDC ${fmt(usdc, 2)} | USDT ${fmt(usdt, 2)} → ${spotTotal}`);

    if (obligations.length > 0) {
      lines.push(`   Kamino: Coll $${fmt(kaminoTotalColl, 2)} | Debt $${fmt(kaminoTotalBorrow, 2)} | Net $${fmt(kaminoNetUsd, 2)} ${emoji}`);
      if (s0 && (s0.totalBorrowUsd > 0 || s0.ltv > 0)) {
        const healthPct = health != null && Number.isFinite(health) && health >= 1
          ? `${fmt(100 * (health - 1) / health, 1)}%`
          : health != null && health < 1
            ? "0% (risk)"
            : "N/A";
        lines.push(`   LTV ${fmt((s0.ltv || 0) * 100, 1)}%`);
        lines.push(`   Health ratio ${fmt(health, 2)} (1.0=liq edge, >1=safe)`);
        lines.push(`   Health ${healthPct} (0%=liq, 100%=max margin)`);

        if (s0.solLiqPrice != null && solPriceUsd && solPriceUsd > 0) {
          const distPct = ((solPriceUsd - s0.solLiqPrice) / solPriceUsd) * 100;
          const distStr = distPct > 0
            ? `SOL must drop ${fmt(distPct, 1)}% for liquidation`
            : distPct < 0
              ? `⚠️ SOL ${fmt(-distPct, 1)}% below liq price`
              : `At liquidation price`;
          lines.push(`   Liq SOL: $${fmt(s0.solLiqPrice, 2)} (now $${fmt(solPriceUsd, 2)}) · ${distStr}`);

          const coll = s0.totalCollUsd;
          const debt = s0.totalBorrowUsd;
          const depositSol = depositUsd > 0 ? depositUsd / solPriceUsd : 0;
          const pctColl = coll > 0 ? fmt(depositUsd / coll * 100, 0) : "—";
          const pctDebt = debt > 0 ? fmt(repayForSameEffect / debt * 100, 0) : "—";
          if (depositUsd > 1) {
            const pLiqAtTarget = solPriceUsd * (1 - targetHealthPct / 100);
            lines.push(`   📌 For Health ${targetHealthPct}% (P_liq ~$${fmt(pLiqAtTarget, 0)}): deposit ~$${fmt(depositUsd, 0)} (~${fmt(depositSol, 2)} SOL, ${pctColl}% coll)`);
            if (repayForSameEffect > 1) {
              lines.push(`   📌 Or repay ~$${fmt(repayForSameEffect, 0)} of debt (${pctDebt}%, same effect)`);
            }
          }
        }
      }
    } else {
      lines.push(`   Kamino: no obligations ${emoji}`);
    }

    lines.push(`   🔗 ${jupLink}`);
    lines.push("");
  }

  lines.push("—");
  const plainMsg = lines.join("\n");
  console.log(plainMsg);

  // Send to Telegram if configured
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChatId = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChatId) {
    const htmlMsg = toTelegramHtml(lines);
    const chunks = splitForTelegram(htmlMsg, 4000);
    for (const chunk of chunks) {
      await sendTelegramMessage(tgToken, tgChatId, chunk);
    }
  }
}

function splitForTelegram(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const idx = remaining.lastIndexOf("\n", maxLen);
    const cut = idx > maxLen / 2 ? idx : maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function toTelegramHtml(lines) {
  return lines
    .map((line) => {
      const mSummary = line.match(/^(\s*)(📋 GLOBAL SUMMARY)/);
      if (mSummary) return mSummary[1] + mSummary[2].replace("GLOBAL SUMMARY", "<b>GLOBAL SUMMARY</b>");
      const mSolPrice = line.match(/^(\s*)(SOL price: )(.+)$/);
      if (mSolPrice) return mSolPrice[1] + "<b>SOL price:</b> " + mSolPrice[3];
      const mKamino = line.match(/^(\s*)(Kamino: )(Coll.+)$/);
      if (mKamino) return mKamino[1] + "<b>Kamino:</b> " + mKamino[3];
      const mHealth = line.match(/^(\s*)(📐 Health in 2 scales:)/);
      if (mHealth) return mHealth[1] + mHealth[2].replace("Health in 2 scales:", "<b>Health in 2 scales:</b>");
      const mFund = line.match(/^(\s*)(👛 )(.+?)( \([\w\d]{4}…[\w\d]{4}\))/);
      if (mFund) return mFund[1] + mFund[2] + "<b>" + escapeHtml(mFund[3]) + "</b>" + mFund[4];
      const mLink = line.match(/^(\s*)(🔗 )(.+)$/);
      if (mLink) return mLink[1] + '<a href="' + mLink[3].replace(/&/g, "&amp;") + '">Jupiter Portfolio</a>';
      return line;
    })
    .join("\n");
}

async function sendTelegramMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || "Telegram API error");
  } catch (e) {
    console.error("Telegram send failed:", e?.message || e);
  }
}

main().catch((e) => {
  console.error("Fatal:", e?.message || e);
  process.exit(1);
});
