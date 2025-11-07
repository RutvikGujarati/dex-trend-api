// ===================================================
// 🏦 Order Monitor + Binance-style Internal Matching + Cleaner
// FIXED: Proper decimal handling and human-readable price display
// ===================================================
import express from "express";
import { ethers } from "ethers";
import { createRequire } from "module";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();
const require = createRequire(import.meta.url);
import { FACTORY_ADDRESS, FACTORY_ABI } from "./constants.js";

// ---- Config ----
const RPC_URL = process.env.RPC_URL || "https://api.skyhighblockchain.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const EXECUTOR_ADDRESS = process.env.EXECUTOR_ADDRESS || "0xfc1224250d6f7E8aced166474849f966914D4141";

// ABIs
const EXECUTOR_ABI = require("./ABI/ABI.json");
const UNISWAP_V3_POOL_ABI = require("./ABI/PoolABI.json");

// ---- RPC / Wallet ----
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ---- Executor (your matching contract) ----
const executor = new ethers.Contract(EXECUTOR_ADDRESS, EXECUTOR_ABI, wallet);

// ---- Constants (BigInt) ----
const ONE_E18 = 1_000_000_000_000_000_000n; // 1e18
const TWO_POW_192 = 1n << 192n;

// ---- Caches ----
const tokenDecimalsCache = new Map();
const tokenSymbolCache = new Map();
const poolInfoCache = new Map();

// ===================================================
// Helpers: ERC20 + Pool meta
// ===================================================
async function getTokenDecimals(addr) {
  const key = addr.toLowerCase();
  if (tokenDecimalsCache.has(key)) return tokenDecimalsCache.get(key);
  const c = new ethers.Contract(addr, ERC20_ABI, provider);
  const d = Number(await c.decimals());
  tokenDecimalsCache.set(key, d);
  return d;
}

async function getTokenSymbol(addr) {
  const key = addr.toLowerCase();
  if (tokenSymbolCache.has(key)) return tokenSymbolCache.get(key);
  const c = new ethers.Contract(addr, ERC20_ABI, provider);
  let s = "";
  try { s = await c.symbol(); } catch { s = key.slice(0, 6); }
  tokenSymbolCache.set(key, s);
  return s;
}

async function getPoolInfo(poolAddr) {
  const key = poolAddr.toLowerCase();
  if (poolInfoCache.has(key)) return poolInfoCache.get(key);
  const pool = new ethers.Contract(poolAddr, UNISWAP_V3_POOL_ABI.abi, provider);
  const [token0, token1, fee] = await Promise.all([pool.token0(), pool.token1(), pool.fee()]);
  const info = { token0: token0.toLowerCase(), token1: token1.toLowerCase(), fee: Number(fee) };
  poolInfoCache.set(key, info);
  return info;
}

// ===================================================
// 🔧 FIX: Convert raw price ratio to human-readable with decimals
// ===================================================
function formatPrice(ratio1e18, decimalsIn, decimalsOut) {
  // ratio1e18 is the raw price (tokenOut per tokenIn) scaled by 1e18
  // Adjust for actual token decimals
  const decimalAdjustment = Math.pow(10, decimalsOut - decimalsIn);
  const humanPrice = (Number(ratio1e18) / 1e18) * decimalAdjustment;
  return humanPrice;
}

// ===================================================
// 🔧 FIX: Format token amount with proper decimals
// ===================================================
function formatAmount(amount, decimals) {
  return Number(amount) / Math.pow(10, decimals);
}

// ===================================================
// Price math (BigInt-safe): tokenIn -> tokenOut using sqrtPriceX96
// ===================================================
function ratio1e18FromSqrt(tokenIn, tokenOut, token0, token1, sqrtPriceX96) {
  const sq = BigInt(sqrtPriceX96);
  const priceX192 = sq * sq;
  if (tokenIn.toLowerCase() === token0 && tokenOut.toLowerCase() === token1) {
    return (priceX192 * ONE_E18) >> 192n;
  } else if (tokenIn.toLowerCase() === token1 && tokenOut.toLowerCase() === token0) {
    return (ONE_E18 * TWO_POW_192) / priceX192;
  } else {
    throw new Error("ratio1e18FromSqrt: invalid token pair for this pool");
  }
}

// ===================================================
// On-chain price ratio from contract
// ===================================================
async function getCurrentPriceFromContract(poolAddr, tokenIn, tokenOut) {
  try {
    const ratio1e18 = await executor.getTokenRatio(poolAddr, tokenIn, tokenOut);
    return Number(ratio1e18) / 1e18;
  } catch (e) {
    console.log(`⚠️ getTokenRatio failed for ${poolAddr}: ${e.message}`);
    return 0;
  }
}

// ===================================================
// Open orders
// ===================================================
async function fetchOpenOrders() {
  const nextIdBN = await executor.nextOrderId();
  const nextId = Number(nextIdBN ?? 0);

  const tasks = [];
  for (let id = 1; id < nextId; id++) {
    tasks.push(
      executor.getOrder(id)
        .then((o) => ({ id, o }))
        .catch(() => null)
    );
  }

  const rows = (await Promise.all(tasks)).filter(Boolean);
  const now = Math.floor(Date.now() / 1000);

  return rows
    .map(({ id, o }) => ({
      id,
      maker: o.maker,
      tokenIn: o.tokenIn.toLowerCase(),
      tokenOut: o.tokenOut.toLowerCase(),
      pool: o.pool.toLowerCase(),
      amountIn: BigInt(o.amountIn),
      targetSqrtPriceX96: BigInt(o.targetSqrtPriceX96),
      expiry: Number(o.expiry),
      filled: o.filled,
      cancelled: o.cancelled,
      orderType: Number(o.orderType),
    }))
    .filter((x) => !x.filled && !x.cancelled && x.expiry > now);
}

function groupKey(a, b, pool) {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `${x}-${y}-${pool.toLowerCase()}`;
}

// ===================================================
// 🔧 FIXED: Binance-style matching with proper decimal formatting
// ===================================================
async function tryInternalMatches() {
  console.log("🔎 [InternalMatch] Starting internal match scan...");

  const open = await fetchOpenOrders();
  console.log(`📦 [InternalMatch] Total open orders fetched: ${open.length}`);
  if (open.length === 0) {
    console.log("⚠️ [InternalMatch] No open orders found. Exiting early.");
    return;
  }

  const groups = new Map();
  for (const o of open) {
    const k = groupKey(o.tokenIn, o.tokenOut, o.pool);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
  }
  console.log(`📊 [InternalMatch] Grouped into ${groups.size} token/pool pairs.`);

  for (const [key, orders] of groups.entries()) {
    const buys = orders.filter((o) => o.orderType === 0);
    const sells = orders.filter((o) => o.orderType === 1);
    if (!buys.length || !sells.length) continue;

    console.log(`📈 [InternalMatch] Group ${key}: ${buys.length} BUY, ${sells.length} SELL`);

    const { token0, token1 } = await getPoolInfo(orders[0].pool);

    // 🔧 FIX: Get decimals for proper formatting
    const tokenInAddr = buys[0].tokenIn;
    const tokenOutAddr = buys[0].tokenOut;
    const decimalsIn = await getTokenDecimals(tokenInAddr);
    const decimalsOut = await getTokenDecimals(tokenOutAddr);

    const buysEnriched = buys.map((b) => ({
      ...b,
      targetPrice1e18: ratio1e18FromSqrt(b.tokenIn, b.tokenOut, token0, token1, b.targetSqrtPriceX96),
    }));
    const sellsEnriched = sells.map((s) => ({
      ...s,
      targetPrice1e18: ratio1e18FromSqrt(s.tokenIn, s.tokenOut, token0, token1, s.targetSqrtPriceX96),
    }));

    buysEnriched.sort((a, b) =>
      a.targetPrice1e18 === b.targetPrice1e18 ? 0 : a.targetPrice1e18 > b.targetPrice1e18 ? -1 : 1
    );
    sellsEnriched.sort((a, b) =>
      a.targetPrice1e18 === b.targetPrice1e18 ? 0 : a.targetPrice1e18 < b.targetPrice1e18 ? -1 : 1
    );

    for (const b of buysEnriched) {
      if (b.amountIn === 0n) continue;

      for (const s of sellsEnriched) {
        if (s.amountIn === 0n) continue;
        if (!(b.tokenIn === s.tokenOut && b.tokenOut === s.tokenIn && b.pool === s.pool)) continue;

        // 🔧 FIX: Format prices properly
        const buyPriceHuman = formatPrice(b.targetPrice1e18, decimalsIn, decimalsOut);
        const sellPriceHuman = formatPrice(s.targetPrice1e18, decimalsIn, decimalsOut);

        const symIn = await getTokenSymbol(b.tokenIn);
        const symOut = await getTokenSymbol(b.tokenOut);

        // 🔧 FIX: Format current price properly
        let currPriceRaw = 0;
        try {
          currPriceRaw = await getCurrentPriceFromContract(b.pool, b.tokenIn, b.tokenOut);
        } catch (err) {
          currPriceRaw = 0;
        }
        const currPrice = currPriceRaw * Math.pow(10, decimalsOut - decimalsIn);

        console.log("───────────────────────────────────────────────");
        console.log(`📊 Pair: ${symIn}/${symOut}`);
        console.log(`💰 Current pool price: ${currPrice.toFixed(8)} ${symOut}/${symIn}`);
        console.log(`🟢 BUY#${b.id} target: ${buyPriceHuman.toFixed(8)} ${symOut}/${symIn}`);
        console.log(`🔴 SELL#${s.id} target: ${sellPriceHuman.toFixed(8)} ${symOut}/${symIn}`);

        const canMatch = b.targetPrice1e18 >= s.targetPrice1e18;
        console.log(
          `⚖️ Comparison: BUY (${buyPriceHuman.toFixed(8)}) ${canMatch ? "≥" : "<"
          } SELL (${sellPriceHuman.toFixed(8)}) → ${canMatch ? "✅ Match" : "❌ Skip"
          }`
        );

        if (!canMatch) continue;

        // 🔧 FIX: Format trade amount properly
        const tradeAmount = b.amountIn < s.amountIn ? b.amountIn : s.amountIn;
        const tradeAmountHuman = formatAmount(tradeAmount, decimalsIn);
        console.log(`📦 Trade amount: ${tradeAmountHuman.toFixed(6)} ${symIn}`);

        try {
          console.log(`🚀 Executing BUY#${b.id} ↔ SELL#${s.id} ...`);
          const tx = await executor.matchOrders(b.id, s.id, { gasLimit: 1_000_000 });
          console.log(`⛽ Tx sent: ${tx.hash}`);
          const r = await tx.wait();
          console.log(`✅ Filled in block ${r.blockNumber}`);
          console.log("───────────────────────────────────────────────\n");

          if (b.amountIn === tradeAmount) b.amountIn = 0n;
          else b.amountIn -= tradeAmount;

          if (s.amountIn === tradeAmount) s.amountIn = 0n;
          else s.amountIn -= tradeAmount;

          if (b.amountIn === 0n) break;
        } catch (e) {
          console.log(`⚠️ [InternalMatch] Failed BUY#${b.id} vs SELL#${s.id}: ${e.message}`);
          console.log("───────────────────────────────────────────────\n");
        }
      }
    }
  }

  console.log("🏁 [InternalMatch] Completed internal match scan.\n");
}

// ===================================================
// Expired orders cleaner (batch)
// ===================================================
async function cleanExpiredOrders(batchSize = 50) {
  try {
    const nextId = Number(await executor.nextOrderId());
    console.log(`🧹 Checking expired orders up to ID ${nextId - 1}`);

    let from = 1;
    while (from < nextId) {
      const to = Math.min(from + batchSize - 1, nextId - 1);
      try {
        const tx = await executor.distributeExpiredOrders(from, to, { gasLimit: 5_000_000 });
        console.log(`⛽ Refund ${from}-${to}: ${tx.hash}`);
        const r = await tx.wait();
        console.log(`✅ Refunded batch ${from}-${to} in block ${r.blockNumber}`);
      } catch (e) {
        console.log(`⚠️ Refund batch ${from}-${to} skipped: ${e.message}`);
      }
      from += batchSize;
    }
  } catch (err) {
    console.error("🚨 Expiry cleanup error:", err.message);
  }
}

// ===================================================
// Monitor loop
// ===================================================
async function monitorOrders(intervalMs = 10_000) {
  console.log("🔎 Order monitor started...");
  while (true) {
    try {
      await tryInternalMatches();
    } catch (e) {
      console.error("🚨 Monitor loop error:", e.message);
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

monitorOrders();


setInterval(() => cleanExpiredOrders(50), 5 * 60 * 1000);

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
// 🧠 AMM BOT SECTION
// ===================================================
const ERC20_ABI = require("./ABI/IERC20.json").abi;

const TOKENS = {
  USDC: "0x553fE3CA2A5F304857A7c2C78b37686716B8c89b",
  USDT: "0xC26efb6DB570DEE4BD0541A1ed52B590F05E3E3B",
  ETH: "0xc671a7a0Bcef13018B384F5af9f4696Aba5Ff0F1"
};
const RANGE_PERCENT = 0.01; // ±1%

// CoinGecko token IDs
const COINGECKO_IDS = {
  ETH: "ethereum",
  USDC: "usd-coin",
  USDT: "tether"
};

// -------------------- Fetch Market Prices --------------------
let cachedPrices = null;
let lastPriceFetch = 0;

async function fetchMarketPrices() {
  const now = Date.now();
  if (cachedPrices && now - lastPriceFetch < 60_000) {
    return cachedPrices; // use cached data
  }

  try {
    const ids = Object.values(COINGECKO_IDS).join(",");
    const res = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
    );

    const prices = {};
    for (const [symbol, id] of Object.entries(COINGECKO_IDS)) {
      prices[symbol] = res.data[id]?.usd || 1;
    }

    cachedPrices = prices;
    lastPriceFetch = now;
    console.log("📊 Market Prices (updated):", prices);
    return prices;
  } catch (err) {
    console.error("⚠ Failed to fetch prices from CoinGecko:", err.message);

    // Fallback: return last cached or static defaults
    if (cachedPrices) {
      console.warn("⚙ Using cached prices due to rate limit.");
      return cachedPrices;
    }
    return { ETH: 3000, USDC: 1, USDT: 1 };
  }
}

async function getCachedMarketPrices() {
  const now = Date.now();
  if (!cachedPrices || now - lastPriceFetch > 60_000) { // 1 min cache
    cachedPrices = await fetchMarketPrices();
    lastPriceFetch = now;
  }
  return cachedPrices;
}
// -------------------- Dynamic Range --------------------
export async function getDynamicRange(tokenA, tokenB) {
  const marketPrices = await getCachedMarketPrices();
  const priceA = marketPrices[tokenA.toUpperCase()] || 1;
  const priceB = marketPrices[tokenB.toUpperCase()] || 1;
  const targetPrice = priceA / priceB;

  return {
    min: targetPrice * (1 - RANGE_PERCENT),
    max: targetPrice * (1 + RANGE_PERCENT),
    targetPrice
  };
}

const BOT_STATE = {
  lastRun: null,
  nextRun: null,
  pairs: []
};

const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);

async function getTokenInfo(token) {
  const c = new ethers.Contract(token, ERC20_ABI, provider);
  const [decimals, symbol] = await Promise.all([c.decimals(), c.symbol()]);
  return { decimals: Number(decimals), symbol };
}

async function getPoolData(tA, tB) {
  const addr = await factory.getPool(tA, tB, 500);
  if (addr === ethers.ZeroAddress) return null;

  const pool = new ethers.Contract(addr, POOL_ABI.abi, provider);

  const [t0, t1, slot0, liquidityBN, fee, tickSpacing] = await Promise.all([
    pool.token0(),
    pool.token1(),
    pool.slot0(),
    pool.liquidity(),
    pool.fee(),
    pool.tickSpacing()
  ]);

  const sqrtPriceX96 = BigInt(slot0[0].toString());
  const sqrtPrice = Number(sqrtPriceX96) / Number(2n ** 96n);
  const price = sqrtPrice ** 2;
  const tick = Number(slot0[1]);
  const liquidity = Number(liquidityBN);

  const [dec0, dec1] = await Promise.all([
    new ethers.Contract(t0, ERC20_ABI, provider).decimals(),
    new ethers.Contract(t1, ERC20_ABI, provider).decimals()
  ]);

  const reserve0 = liquidity / sqrtPrice;
  const reserve1 = liquidity * sqrtPrice;

  const token0Reserve = reserve0 / 10 ** Number(dec0);
  const token1Reserve = reserve1 / 10 ** Number(dec1);

  return {
    addr,
    token0: t0,
    token1: t1,
    price,
    sqrtPrice,
    tick,
    liquidity,
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    reserves: {
      token0Reserve,
      token1Reserve,
      decimals0: Number(dec0),
      decimals1: Number(dec1)
    }
  };
}

// -------------------- Rebalance Core --------------------
async function rebalance(tA, tB, marketPrice) {
  if (!marketPrice) return { error: "Market price data missing" };

  const cfg = await getDynamicRange(tA, tB);
  if (!cfg) return { error: "No config for pair" };

  const [infoA, infoB, pd] = await Promise.all([
    getTokenInfo(tA),
    getTokenInfo(tB),
    getPoolData(tA, tB)
  ]);

  if (!pd) return { error: "Pool not found" };

  if (!marketPrice[infoA.symbol] || !marketPrice[infoB.symbol]) {
    return { error: `Missing price for ${infoA.symbol}/${infoB.symbol}` };
  }

  const targetPrice = marketPrice[infoA.symbol] / marketPrice[infoB.symbol];
  const lower = targetPrice * 0.99;
  const upper = targetPrice * 1.01;
  const poolPrice = pd.token0.toLowerCase() === tA.toLowerCase() ? pd.price : 1 / pd.price;
  const inRange = poolPrice >= cfg.min && poolPrice <= cfg.max;
  const side = poolPrice < cfg.min ? "Below" : poolPrice > cfg.max ? "Above" : "In Range";

  const reserve0 = pd.reserves.token0Reserve;
  const reserve1 = pd.reserves.token1Reserve;
  const ETH_ADDRESSES = [
    TOKENS.ETH.toLowerCase(),
    "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
  ];

  let token0ValueETH = 0;
  let token1ValueETH = 0;

  if (ETH_ADDRESSES.includes(tA.toLowerCase())) {
    token0ValueETH = reserve0;
    token1ValueETH = reserve1 / poolPrice;
  } else if (ETH_ADDRESSES.includes(tB.toLowerCase())) {
    token1ValueETH = reserve1;
    token0ValueETH = reserve0 * poolPrice;
  } else {
    const ETH_PRICE = marketPrice.ETH || 3000;
    token0ValueETH = reserve0 / ETH_PRICE;
    token1ValueETH = reserve1 / ETH_PRICE;
  }

  const totalValueETH = token0ValueETH + token1ValueETH;

  return {
    pair: `${infoA.symbol}/${infoB.symbol}`,
    poolAddress: pd.addr,
    price: poolPrice.toFixed(6),
    range: `[${lower.toFixed(6)}, ${upper.toFixed(6)}]`,
    tick: pd.tick,
    fee: pd.fee,
    liquidity: pd.liquidity.toFixed(2),
    tokenReserves: {
      token0: `${reserve0.toFixed(2)} ${infoA.symbol}`,
      token1: `${reserve1.toFixed(2)} ${infoB.symbol}`,
    },
    totalValueETH: `${totalValueETH.toFixed(4)} ETH`,
    status: inRange ? "✅ In Range" : `⚠ ${side} Range`
  };
}

// -------------------- AMM API Endpoints --------------------
app.get("/amm/status", async (req, res) => {
  try {
    const pairs = await Promise.all([
      rebalance(TOKENS.USDC, TOKENS.USDT, await getCachedMarketPrices()),
      rebalance(TOKENS.ETH, TOKENS.USDC, await getCachedMarketPrices()),
      rebalance(TOKENS.ETH, TOKENS.USDT, await getCachedMarketPrices())
    ]);

    BOT_STATE.lastRun = new Date().toLocaleString();
    BOT_STATE.nextRun = new Date(Date.now() + 60000).toLocaleString();
    BOT_STATE.pairs = pairs;

    res.json(BOT_STATE);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/amm/rebalance/:pair", async (req, res) => {
  try {
    const [tA, tB] = req.params.pair.split("-");
    if (!tA || !tB) return res.status(400).json({ error: "Invalid pair format" });

    const market = await getCachedMarketPrices();
    const result = await rebalance(tA, tB, market);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================================================
app.listen(PORT, () => {
  console.log(`🚀 Unified Server running at http://localhost:${PORT}`);
});
