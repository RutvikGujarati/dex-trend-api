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

// Minimal ERC20 ABI
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)"
];

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

const ALLOWED_SELF_MATCH = "0x3bdbb84b90abaf52814aab54b9622408f2dca483";

// track how many times a specific buy/sell pair was tried
const matchAttemptCount = new Map();

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

    const maker = o.maker || ethers.ZeroAddress;
    const tokenIn = o.tokenIn ? o.tokenIn.toLowerCase() : ethers.ZeroAddress;
    const tokenOut = o.tokenOut ? o.tokenOut.toLowerCase() : ethers.ZeroAddress;
    const pool = o.pool ? o.pool.toLowerCase() : ethers.ZeroAddress;

    let amountIn, expiry, orderType, filled, cancelled, targetPrice1e18;

    try { amountIn = BigInt(o.amountIn?.toString() ?? "0"); } catch { amountIn = 0n; }
    try { expiry = Number(o.expiry?.toString() ?? 0); } catch { expiry = 0; }
    try { orderType = Number(o.orderType ?? 0); } catch { orderType = 0; }
    try { filled = Boolean(o.filled); } catch { filled = false; }
    try { cancelled = Boolean(o.cancelled); } catch { cancelled = false; }
    try { targetPrice1e18 = BigInt(o.targetPrice1e18?.toString() ?? "0"); } catch { targetPrice1e18 = 0n; }

    if (!maker || maker === ethers.ZeroAddress) continue;

    if (!filled && !cancelled && expiry > now && amountIn > 0n) {
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
   Price comparison with tolerance for rounding errors
------------------------------------------------------------------------ */
function pricesMatch(buyPrice, sellPrice) {
  const tolerance = BigInt(Math.floor(Number(buyPrice) * 0.0001));
  return buyPrice >= (sellPrice - tolerance);
}

/* ----------------------------------------------------------------------
   MATCHING LOGIC with "3 strikes then cancel" per pair
------------------------------------------------------------------------ */
async function tryInternalMatches() {
  console.log("\n🔍 Checking for matches...");

  const open = await fetchOpenOrders();
  if (!open.length) {
    console.log("ℹ️ No open orders.");
    return;
  }

  console.log(`📊 Found ${open.length} open orders`);

  const groups = new Map();
  for (const o of open) {
    const key = pairKey(o.tokenIn, o.tokenOut);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }

  console.log(`🔗 Found ${groups.size} trading pairs`);

  for (const [key, orders] of groups.entries()) {
    if (!orders.length) continue;

    const buys = orders.filter(o => o.orderType === 0);
    const sells = orders.filter(o => o.orderType === 1);

    if (!buys.length || !sells.length) {
      console.log(`⏭️ Pair ${key}: ${buys.length} buys, ${sells.length} sells - skipping`);
      continue;
    }

    console.log(`\n📈 Pair ${key}: ${buys.length} buys, ${sells.length} sells`);

    buys.sort((a, b) => Number(b.targetPrice1e18 - a.targetPrice1e18));
    sells.sort((a, b) => Number(a.targetPrice1e18 - b.targetPrice1e18));

    for (const buy of buys) {
      for (const sell of sells) {
        const buyMaker = buy.maker.toLowerCase();
        const sellMaker = sell.maker.toLowerCase();
        const DUST_THRESHOLD = 1_000_000_000_000n; // 1e12 wei = 0.000001 tokens (for 18 decimals)

        if (buy.amountIn < DUST_THRESHOLD) {
          console.log(`⚠️ BUY#${buy.id} is dust: ${buy.amountIn}. Handling...`);

          if (buyMaker === ALLOWED_SELF_MATCH.toLowerCase()) {
            console.log(`🗑️ Cancelling your dust BUY#${buy.id}`);
            try {
              const tx = await executor.cancelOrder(buy.id);
              console.log(`   ⛽ Cancel BUY tx: ${tx.hash}`);
              await tx.wait();
            } catch (e) {
              console.log(`   ❌ Failed to cancel BUY: ${e.message}`);
            }
          } else {
            console.log(`⛔ Skipping dust BUY#${buy.id} (not your order)`);
          }
          continue; // skip matching completely
        }

        if (sell.amountIn < DUST_THRESHOLD) {
          console.log(`⚠️ SELL#${sell.id} is dust: ${sell.amountIn}. Handling...`);

          if (sellMaker === ALLOWED_SELF_MATCH.toLowerCase()) {
            console.log(`🗑️ Cancelling your dust SELL#${sell.id}`);
            try {
              const tx = await executor.cancelOrder(sell.id);
              console.log(`   ⛽ Cancel SELL tx: ${tx.hash}`);
              await tx.wait();
            } catch (e) {
              console.log(`   ❌ Failed to cancel SELL: ${e.message}`);
            }
          } else {
            console.log(`⛔ Skipping dust SELL#${sell.id} (not your order)`);
          }
          continue;
        }

        if (buyMaker === sellMaker && buyMaker !== ALLOWED_SELF_MATCH.toLowerCase()) {
          console.log(`⏭️ Skipping self-match: BUY#${buy.id} and SELL#${sell.id}`);
          continue;
        }

        if (buyMaker === sellMaker && buyMaker === ALLOWED_SELF_MATCH.toLowerCase()) {
          console.log(`✅ Allowing self-match for whitelisted address: BUY#${buy.id} and SELL#${sell.id}`);
        }

        if (!pricesMatch(buy.targetPrice1e18, sell.targetPrice1e18)) {
          console.log(
            `⏭️ Price mismatch: BUY#${buy.id} (${ethers.formatUnits(
              buy.targetPrice1e18,
              18
            )}) < SELL#${sell.id} (${ethers.formatUnits(sell.targetPrice1e18, 18)})`
          );
          continue;
        }

        // track attempts per BUY/SELL pair
        const pairIdKey = `${buy.id}-${sell.id}`;
        const prevAttempts = matchAttemptCount.get(pairIdKey) || 0;
        const attempts = prevAttempts + 1;
        matchAttemptCount.set(pairIdKey, attempts);

        console.log(
          `\n🔥 MATCH FOUND! BUY#${buy.id} / SELL#${sell.id} (attempt ${attempts})`
        );
        console.log(
          `   BUY#${buy.id}: ${ethers.formatUnits(
            buy.amountIn,
            18
          )} @ ${ethers.formatUnits(buy.targetPrice1e18, 18)}`
        );
        console.log(
          `   SELL#${sell.id}: ${ethers.formatUnits(
            sell.amountIn,
            18
          )} @ ${ethers.formatUnits(sell.targetPrice1e18, 18)}`
        );

        // if this pair reached 3rd attempt, cancel both orders
        if (attempts >= 3) {
          console.log(`🚫 Too many attempts for BUY#${buy.id} / SELL#${sell.id}`);

          if (buyMaker === ALLOWED_SELF_MATCH.toLowerCase()) {
            try {
              const tx1 = await executor.cancelOrder(buy.id);
              console.log(`   🗑️ Cancelled your BUY#${buy.id}`);
              await tx1.wait();
            } catch (e) {
              console.log(`   ❌ Failed to cancel BUY: ${e.message}`);
            }
          } else {
            console.log(`⛔ Not allowed to cancel BUY#${buy.id} (not your address)`);
          }

          if (sellMaker === ALLOWED_SELF_MATCH.toLowerCase()) {
            try {
              const tx2 = await executor.cancelOrder(sell.id);
              console.log(`   🗑️ Cancelled your SELL#${sell.id}`);
              await tx2.wait();
            } catch (e) {
              console.log(`   ❌ Failed to cancel SELL: ${e.message}`);
            }
          } else {
            console.log(`⛔ Not allowed to cancel SELL#${sell.id} (not your address)`);
          }

          matchAttemptCount.delete(pairIdKey);
          console.log("🛑 Skipping this pair further");
          continue;
        }


        try {
          const tx = await executor.matchOrders(buy.id, sell.id, {
            gasLimit: 1_500_000
          });
          console.log(`   ⛽ Tx: ${tx.hash}`);
          const rc = await tx.wait();
          console.log(`   ✅ Matched at block ${rc.blockNumber}`);
        } catch (err) {
          console.log(`   ❌ Match failed: ${err.message}`);
          continue;
        }

        const updatedBuy = await executor.getOrder(buy.id);
        const updatedSell = await executor.getOrder(sell.id);

        const buyAmountLeft = BigInt(updatedBuy.amountIn?.toString() ?? "0");
        const sellAmountLeft = BigInt(updatedSell.amountIn?.toString() ?? "0");

        console.log(
          `   📊 Remaining: BUY=${ethers.formatUnits(
            buyAmountLeft,
            18
          )}, SELL=${ethers.formatUnits(sellAmountLeft, 18)}`
        );

        const buyClosed =
          updatedBuy.filled ||
          updatedBuy.cancelled ||
          buyAmountLeft === 0n;

        const sellClosed =
          updatedSell.filled ||
          updatedSell.cancelled ||
          sellAmountLeft === 0n;

        if (buyClosed || sellClosed) {
          console.log(
            "   🛑 Order closed → stopping further matches for this pair"
          );
          return;
        }

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

app.get("/", (req, res) =>
  res.json({ status: "ok", executor: EXECUTOR_ADDRESS })
);

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
