// matcherBot.js
import { ethers } from "ethers";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import EXECUTOR_ABI from "./ABI/ABI.json" with { type: "json" };

dotenv.config();

const RPC_URL = process.env.RPC_URL || "https://api.skyhighblockchain.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const EXECUTOR_ADDRESS = "0x14e904F5FfA5748813859879f8cA20e487F407D8";
const ALLOWED_SELF_MATCH = "0x3bdbb84b90abaf52814aab54b9622408f2dca483";
const DUST_THRESHOLD = 1_000_000_000_000n;

if (!PRIVATE_KEY) {
  console.error("❌ Missing PRIVATE_KEY in .env");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const executor = new ethers.Contract(EXECUTOR_ADDRESS, EXECUTOR_ABI, wallet);

const ERC20_ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];

const botStats = {
  totalVolume24h: {},
  totalTrades: 0,
  activePairs: 0,
  liquidity: {},
  lastTradeTime: null,
  avgTradeSize: {},
  successRate: 0
};
async function convertLiquidityToSymbols(liquidityObj) {
  const out = {};

  for (const [key, v] of Object.entries(liquidityObj)) {
    const [addrA, addrB] = key.split("-");

    const symA = await getSymbol(addrA);
    const symB = await getSymbol(addrB);

    const pairLabel = `${symA}/${symB}`;

    out[pairLabel] = {
      buyLiquidity: ethers.formatEther(v.buyLiquidity),
      sellLiquidity: ethers.formatEther(v.sellLiquidity),
      totalLiquidity: ethers.formatEther(v.buyLiquidity + v.sellLiquidity),
      buyOrders: v.buyOrders,
      sellOrders: v.sellOrders,
      totalOrders: v.buyOrders + v.sellOrders,
      spread: `${v.spread.toFixed(4)}%`
    };
  }

  return out;
}

const tokenCache = new Map();
const matchAttemptCount = new Map();

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

async function fetchOpenOrders() {
  const nextIdBN = await executor.nextOrderId();
  const nextId = Number(nextIdBN ?? 0);
  const now = Math.floor(Date.now() / 1000);

  const tasks = [];
  for (let id = 1; id < nextId; id++) {
    tasks.push(
      executor.getOrder(id)
        .then(o => ({ id, o }))
        .catch(() => null)
    );
  }

  const results = (await Promise.all(tasks)).filter(Boolean);
  const open = [];

  for (const { id, o } of results) {
    if (!o) continue;

    const maker = o.maker || ethers.ZeroAddress;
    if (!maker || maker === ethers.ZeroAddress) continue;

    const tokenIn = (o.tokenIn || ethers.ZeroAddress).toLowerCase();
    const tokenOut = (o.tokenOut || ethers.ZeroAddress).toLowerCase();

    try {
      const amountIn = BigInt(o.amountIn?.toString() ?? "0");
      const expiry = Number(o.expiry?.toString() ?? 0);
      const orderType = Number(o.orderType ?? 0);
      const filled = Boolean(o.filled);
      const cancelled = Boolean(o.cancelled);
      const targetPrice1e18 = BigInt(o.targetPrice1e18?.toString() ?? "0");

      if (!filled && !cancelled && expiry > now && amountIn > 0n) {
        open.push({
          id, maker, tokenIn, tokenOut,
          pool: (o.pool || ethers.ZeroAddress).toLowerCase(),
          amountIn, expiry, filled, cancelled, orderType, targetPrice1e18
        });
      }
    } catch (e) {
      continue;
    }
  }

  return open;
}

function pairKey(a, b) {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `${x}-${y}`;
}

function pricesMatch(buyPrice, sellPrice) {
  const tolerance = BigInt(Math.floor(Number(buyPrice) * 0.0001));
  return buyPrice >= (sellPrice - tolerance);
}

async function calculateLiquidity(open) {
  const liquidityByPair = {};

  for (const order of open) {
    const key = pairKey(order.tokenIn, order.tokenOut);

    if (!liquidityByPair[key]) {
      liquidityByPair[key] = {
        buyLiquidity: 0n,
        sellLiquidity: 0n,
        buyOrders: 0,
        sellOrders: 0,
        spread: 0
      };
    }

    if (order.orderType === 0) {
      liquidityByPair[key].buyLiquidity += order.amountIn;
      liquidityByPair[key].buyOrders++;
    } else {
      liquidityByPair[key].sellLiquidity += order.amountIn;
      liquidityByPair[key].sellOrders++;
    }
  }

  // Calculate spreads
  for (const [key, orders] of Object.entries(liquidityByPair)) {
    const pairOrders = open.filter(o => pairKey(o.tokenIn, o.tokenOut) === key);
    const buys = pairOrders.filter(o => o.orderType === 0).sort((a, b) =>
      Number(b.targetPrice1e18 - a.targetPrice1e18)
    );
    const sells = pairOrders.filter(o => o.orderType === 1).sort((a, b) =>
      Number(a.targetPrice1e18 - b.targetPrice1e18)
    );

    if (buys.length > 0 && sells.length > 0) {
      const bestBuy = Number(ethers.formatUnits(buys[0].targetPrice1e18, 18));
      const bestSell = Number(ethers.formatUnits(sells[0].targetPrice1e18, 18));
      const spread = ((bestSell - bestBuy) / bestBuy) * 100;
      liquidityByPair[key].spread = spread;
    }
  }

  return liquidityByPair;
}

async function updateAMMStats(pairK, amount, price) {
  botStats.totalVolume24h[pairK] = (botStats.totalVolume24h[pairK] || 0n) + amount;
  botStats.totalTrades++;
  botStats.lastTradeTime = Date.now();

  if (!botStats.avgTradeSize[pairK]) {
    botStats.avgTradeSize[pairK] = { total: 0n, count: 0 };
  }
  botStats.avgTradeSize[pairK].total += amount;
  botStats.avgTradeSize[pairK].count++;
}

async function tryInternalMatches() {
  console.log("\n🔍 Scanning order book...");

  const open = await fetchOpenOrders();
  if (!open.length) {
    console.log("ℹ️ No open orders.");
    return;
  }

  console.log(`📊 ${open.length} active orders`);

  const groups = new Map();
  for (const o of open) {
    const key = pairKey(o.tokenIn, o.tokenOut);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }

  botStats.activePairs = groups.size;
  botStats.liquidity = await calculateLiquidity(open);
  console.log(`🔗 ${groups.size} active pairs`);

  for (const [key, orders] of groups.entries()) {
    const buys = orders.filter(o => o.orderType === 0).sort((a, b) =>
      Number(b.targetPrice1e18 - a.targetPrice1e18)
    );
    const sells = orders.filter(o => o.orderType === 1).sort((a, b) =>
      Number(a.targetPrice1e18 - b.targetPrice1e18)
    );

    if (!buys.length || !sells.length) continue;

    console.log(`\n💱 ${key}: ${buys.length}/${sells.length}`);

    for (const buy of buys) {
      for (const sell of sells) {
        const buyMaker = buy.maker.toLowerCase();
        const sellMaker = sell.maker.toLowerCase();

        // Handle dust orders
        if (buy.amountIn < DUST_THRESHOLD || sell.amountIn < DUST_THRESHOLD) {
          if (buyMaker === ALLOWED_SELF_MATCH.toLowerCase() || sellMaker === ALLOWED_SELF_MATCH.toLowerCase()) {
            try {
              if (buy.amountIn < DUST_THRESHOLD) await executor.cancelOrder(buy.id);
              if (sell.amountIn < DUST_THRESHOLD) await executor.cancelOrder(sell.id);
            } catch { }
          }
          continue;
        }

        // Self-match check
        if (buyMaker === sellMaker && buyMaker !== ALLOWED_SELF_MATCH.toLowerCase()) continue;

        // Price match
        if (!pricesMatch(buy.targetPrice1e18, sell.targetPrice1e18)) continue;

        const pairIdKey = `${buy.id}-${sell.id}`;
        const attempts = (matchAttemptCount.get(pairIdKey) || 0) + 1;
        matchAttemptCount.set(pairIdKey, attempts);

        console.log(`\n🔥 MATCH: BUY#${buy.id} ↔ SELL#${sell.id} (try ${attempts})`);

        // Cancel after 3 failed attempts
        if (attempts >= 3) {
          console.log("🚫 Too many attempts, cancelling...");
          if (buyMaker === ALLOWED_SELF_MATCH.toLowerCase()) {
            try { await executor.cancelOrder(buy.id); } catch { }
          }
          if (sellMaker === ALLOWED_SELF_MATCH.toLowerCase()) {
            try { await executor.cancelOrder(sell.id); } catch { }
          }
          matchAttemptCount.delete(pairIdKey);
          continue;
        }

        try {
          const tx = await executor.matchOrders(buy.id, sell.id, { gasLimit: 1_500_000 });
          await tx.wait();
          console.log(`✅ Matched: ${tx.hash}`);

          const amount = buy.amountIn < sell.amountIn ? buy.amountIn : sell.amountIn;
          await updateAMMStats(key, amount, buy.targetPrice1e18);

          botStats.successRate = (botStats.totalTrades / (botStats.totalTrades + 1)) * 100;
        } catch (err) {
          console.log(`❌ ${err.message}`);
          continue;
        }
        break;
      }
    }
  }

  console.log("🏁 Cycle complete\n");
}

async function start(intervalMs = 10000) {
  console.log("🟢 Matcher bot online");
  while (true) {
    try {
      await tryInternalMatches();
    } catch (err) {
      console.error("⚠️", err.message);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

start();

const app = express();
app.use(cors({ origin: "*" }));
const PORT = process.env.PORT || 4000;

app.get("/", (req, res) => res.json({ status: "online", executor: EXECUTOR_ADDRESS }));

app.get("/stats", async (req, res) => {
  const liquiditySymbols = await convertLiquidityToSymbols(botStats.liquidity);

  const formattedStats = {
    totalTrades: botStats.totalTrades,
    activePairs: botStats.activePairs,
    volume24h: Object.fromEntries(
      Object.entries(botStats.totalVolume24h).map(([k, v]) => [k, ethers.formatEther(v)])
    ),
    liquidity: liquiditySymbols,

    avgTradeSize: Object.fromEntries(
      Object.entries(botStats.avgTradeSize).map(([k, v]) => [
        k,
        v.count > 0 ? ethers.formatEther(v.total / BigInt(v.count)) : "0"
      ])
    ),
    successRate: `${botStats.successRate.toFixed(2)}%`,
    lastTrade: botStats.lastTradeTime ? new Date(botStats.lastTradeTime).toISOString() : null
  };
  res.json(formattedStats);
});

app.get("/order/:id", async (req, res) => {
  try {
    const o = await executor.getOrder(req.params.id);
    res.json(o);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server: http://localhost:${PORT}`);
});