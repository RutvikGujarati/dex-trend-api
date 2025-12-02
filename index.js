// matcherBot.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
import axios from "axios";
import POOL_ABI from "./ABI/PoolABI.json" with { type: "json" };
import EXECUTOR_ABI from "./ABI/ABI.json" with { type: "json" };

const RPC_URL = process.env.RPC_URL || "https://api.skyhighblockchain.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const EXECUTOR_ADDRESS = "0x14e904F5FfA5748813859879f8cA20e487F407D8";

if (!PRIVATE_KEY) {
  console.error("❌ Missing PRIVATE_KEY in .env");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const executor = new ethers.Contract(EXECUTOR_ADDRESS, EXECUTOR_ABI, wallet);

// minimal ABI

// cache symbols
const tokenCache = new Map();

async function getSymbol(addr) {
  const key = addr.toLowerCase();
  if (tokenCache.has(key)) return tokenCache.get(key);

  try {
    const c = new ethers.Contract(addr, ERC20_ABI, provider);
    const s = await c.symbol();
    tokenCache.set(key, s);
    return s;
  } catch {
    const fallback = addr.substring(0, 6);
    tokenCache.set(key, fallback);
    return fallback;
  }
}

/* ----------------------------------------------------------------------
   FETCH ALL OPEN ORDERS
------------------------------------------------------------------------ */
async function fetchOpenOrders() {
  const nextIdBN = await executor.nextOrderId();
  const nextId = Number(nextIdBN ?? 0);

  const tasks = [];
  for (let id = 1; id < nextId; id++) {
    tasks.push(
      executor.getOrder(id)
        .then(o => ({ id, o }))
        .catch(() => null)
    );
  }

  const results = (await Promise.all(tasks)).filter(Boolean);
  const now = Math.floor(Date.now() / 1000);
  const open = [];

  for (const { id, o } of results) {
    if (!o) continue;

    // ---- Defensive extraction ----
    const maker = o.maker || ethers.ZeroAddress;
    const tokenIn = o.tokenIn ? o.tokenIn.toLowerCase() : ethers.ZeroAddress;
    const tokenOut = o.tokenOut ? o.tokenOut.toLowerCase() : ethers.ZeroAddress;
    const pool = o.pool ? o.pool.toLowerCase() : ethers.ZeroAddress;

    // numeric conversions, fallback to zero
    let amountIn, expiry, orderType, filled, cancelled, targetPrice1e18;

    try { amountIn = BigInt(o.amountIn?.toString() ?? "0"); } catch { amountIn = 0n; }
    try { expiry = Number(o.expiry?.toString() ?? 0); } catch { expiry = 0; }
    try { orderType = Number(o.orderType ?? 0); } catch { orderType = 0; }
    try { filled = Boolean(o.filled); } catch { filled = false; }
    try { cancelled = Boolean(o.cancelled); } catch { cancelled = false; }
    try { targetPrice1e18 = BigInt(o.targetPrice1e18?.toString() ?? "0"); } catch { targetPrice1e18 = 0n; }

    // skip invalid or zero orders
    if (!maker || maker === ethers.ZeroAddress) continue;

    // FILTER active orders
    if (!filled && !cancelled && expiry > now) {
      open.push({
        id,
        maker,
        tokenIn,
        tokenOut,
        pool,
        amountIn,
        expiry,
        filled,
        cancelled,
        orderType,
        targetPrice1e18
      });
    }
  }

  return open;
}

/* ----------------------------------------------------------------------
   Group key
------------------------------------------------------------------------ */
function pairKey(a, b) {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `${x}-${y}`;
}

/* ----------------------------------------------------------------------
   SIMPLIFIED MATCHING LOGIC - Just compare buy vs sell prices
------------------------------------------------------------------------ */
async function tryInternalMatches() {
  console.log("\n🔍 Checking for matches...");

  const open = await fetchOpenOrders();
  if (!open.length) {
    console.log("ℹ️ No open orders.");
    return;
  }

  // group by token pairs
  const groups = new Map();
  for (const o of open) {
    const key = pairKey(o.tokenIn, o.tokenOut);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }

  for (const [key, orders] of groups.entries()) {
    if (!orders.length) continue;

    const buys = orders.filter(o => o.orderType === 0);
    const sells = orders.filter(o => o.orderType === 1);

    if (!buys.length || !sells.length) continue;

    // sort
    buys.sort((a, b) => Number(b.targetPrice1e18 - a.targetPrice1e18));
    sells.sort((a, b) => Number(a.targetPrice1e18 - b.targetPrice1e18));

    // match once per pair
    for (const buy of buys) {
      for (const sell of sells) {

        if (buy.targetPrice1e18 < sell.targetPrice1e18) continue;

        console.log(`\n🔥 MATCH BUY#${buy.id} >= SELL#${sell.id}`);

        try {
          const tx = await executor.matchOrders(buy.id, sell.id, {
            gasLimit: 1_500_000
          });
          console.log(`   ⛽ Tx: ${tx.hash}`);
          const rc = await tx.wait();
          console.log(`   ✔ matched at block ${rc.blockNumber}`);
        } catch (err) {
          console.log(`   ❌ Match failed: ${err.message}`);
        }

        // ⛔ MUST RELOAD ORDER STATE AFTER MATCHING
        const updatedBuy = await executor.getOrder(buy.id);
        const updatedSell = await executor.getOrder(sell.id);

        const buyClosed =
          updatedBuy.filled ||
          updatedBuy.cancelled ||
          updatedBuy.amountIn === 0n;

        const sellClosed =
          updatedSell.filled ||
          updatedSell.cancelled ||
          updatedSell.amountIn === 0n;

        // STOP re-matching
        if (buyClosed || sellClosed) {
          console.log("   🛑 Order closed → stopping further matches for this pair");
          return; // finish this whole cycle
        }

        // break inner loop, continue matching next buy with next sells
        break;
      }
    }
  }

  console.log("\n🏁 Match cycle complete.\n");
}


/* ----------------------------------------------------------------------
   LOOP
------------------------------------------------------------------------ */
async function start(intervalMs = 10000) {
  console.log("🟢 Matcher bot started…");
  while (true) {
    try {
      await tryInternalMatches();
    } catch (err) {
      console.error("⚠️ Loop error:", err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

start();

// ===================================================
// Tiny Express API
// ===================================================
const app = express();
app.use(cors({ origin: "*" }));
const PORT = process.env.PORT || 4000;

app.get("/", (req, res) => res.json({ status: "ok", executor: EXECUTOR_ADDRESS }));

app.get("/order/:id", async (req, res) => {
  try {
    const o = await executor.getOrder(req.params.id);
    res.json(o);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===================================================
app.listen(PORT, () => {
  console.log(`🚀 Unified Server running at http://localhost:${PORT}`);
});
