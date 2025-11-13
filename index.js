// ===================================================
// 🏦 Minimal Order Monitor + Matching Bot
// Uses only contract data (no Uniswap SDK / no pool info)
// ===================================================
import { ethers } from "ethers";
import express from "express";
import cors from "cors";
import { createRequire } from "module";
import dotenv from "dotenv";
dotenv.config();
const require = createRequire(import.meta.url);

// ---- CONFIG ----
const RPC_URL = process.env.RPC_URL || "https://api.skyhighblockchain.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const EXECUTOR_ADDRESS = "0x0685ceAd5D9653C29B54b2B53E2c6454C074eBdB";

// ---- ABIs ----
const EXECUTOR_ABI = require("./ABI/ABI.json");

// ---- SETUP ----
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const executor = new ethers.Contract(EXECUTOR_ADDRESS, EXECUTOR_ABI, wallet);

// ===================================================
// 🔹 Fetch All Open Orders
// ===================================================
async function fetchOpenOrders() {
  const nextIdBN = await executor.nextOrderId();
  const nextId = Number(nextIdBN ?? 0);

  const tasks = [];
  for (let id = 1; id < nextId; id++) {
    tasks.push(
      executor
        .getOrder(id)
        .then((o) => ({ id, o }))
        .catch(() => null)
    );
  }

  const results = (await Promise.all(tasks)).filter(Boolean);
  const now = Math.floor(Date.now() / 1000);

  return results
    .map(({ id, o }) => ({
      id,
      maker: o.maker,
      tokenIn: o.tokenIn.toLowerCase(),
      tokenOut: o.tokenOut.toLowerCase(),
      pool: o.pool.toLowerCase(),
      amountIn: BigInt(o.amountIn),
      expiry: Number(o.expiry),
      filled: o.filled,
      cancelled: o.cancelled,
      orderType: Number(o.orderType),
      targetSqrtPriceX96: BigInt(o.targetSqrtPriceX96),
    }))
    .filter((o) => !o.filled && !o.cancelled && o.expiry > now);
}

// ===================================================
// 🔹 Simple Pair Key (grouping BUY vs SELL)
// ===================================================
function groupKey(a, b, pool) {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `${x}-${y}-${pool.toLowerCase()}`;
}

// ===================================================
// 🔹 Internal Matching Logic (Binance-style)
// ===================================================
const tokenCache = new Map();

async function getTokenSymbol(addr, providerOrSigner) {
  const provider =
    providerOrSigner.provider || providerOrSigner; // ensure real provider

  const key = addr.toLowerCase();
  if (tokenCache.has(key)) return tokenCache.get(key);

  try {
    const token = new ethers.Contract(addr, ERC20_ABI, provider);
    const symbol = await token.symbol();
    tokenCache.set(key, symbol);
    return symbol;
  } catch (err) {
    console.warn(`⚠️ Failed to fetch symbol for ${addr}: ${err.message}`);
    const fallback = addr.slice(0, 6);
    tokenCache.set(key, fallback);
    return fallback;
  }
}

async function tryInternalMatches() {
  console.log("\n🔍 Checking for internal matches...");

  const openOrders = await fetchOpenOrders();
  console.log(`📦 Total open orders: ${openOrders.length}`);

  if (openOrders.length === 0) return;

  // Group orders by token pair + pool
  const groups = new Map();
  for (const o of openOrders) {
    const key = groupKey(o.tokenIn, o.tokenOut, o.pool);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }

  for (const [key, orders] of groups.entries()) {
    if (!orders.length) continue;

    // Fetch token symbols dynamically (once per group)
    const example = orders[0];
    const tokenInSym = await getTokenSymbol(example.tokenIn, provider);
    const tokenOutSym = await getTokenSymbol(example.tokenOut, provider);

    const buys = orders.filter((o) => o.orderType === 0);
    const sells = orders.filter((o) => o.orderType === 1);
    if (!buys.length || !sells.length) continue;

    console.log(`\n🔹 ${tokenInSym}/${tokenOutSym} [Pool: ${example.pool.slice(0, 8)}...]`);
    console.log(`   🟢 BUY: ${buys.length} | 🔴 SELL: ${sells.length}`);

    // Sort BUY high→low, SELL low→high
    buys.sort((a, b) => Number(b.targetSqrtPriceX96) - Number(a.targetSqrtPriceX96));
    sells.sort((a, b) => Number(a.targetSqrtPriceX96) - Number(b.targetSqrtPriceX96));

    for (const buy of buys) {
      for (const sell of sells) {
        if (
          !(buy.tokenIn === sell.tokenOut &&
            buy.tokenOut === sell.tokenIn &&
            buy.pool === sell.pool)
        )
          continue;

        const buyPrice = parseFloat(ethers.formatUnits(buy.targetSqrtPriceX96, 18)).toFixed(6);
        const sellPrice = parseFloat(ethers.formatUnits(sell.targetSqrtPriceX96, 18)).toFixed(6);

        console.log(
          `   🔄 BUY#${buy.id}(${tokenInSym}→${tokenOutSym}, ${buyPrice}) vs SELL#${sell.id}(${tokenOutSym}→${tokenInSym}, ${sellPrice})`
        );

        if (buyPrice >= sellPrice && sellPrice > 0) {
          console.log(
            `   ✅ Match found! BUY#${buy.id} ≥ SELL#${sell.id} | Price: ${buyPrice} ≥ ${sellPrice}`
          );

          const tradeAmount = buy.amountIn < sell.amountIn ? buy.amountIn : sell.amountIn;
          console.log(`   💰 Trade amount: ${tradeAmount.toString()}`);

          try {
            const tx = await executor.matchOrders(buy.id, sell.id, { gasLimit: 1_000_000 });
            console.log(`   ⛽ Tx: ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`   ✅ Executed successfully in block ${receipt.blockNumber}`);
          } catch (err) {
            console.log(`   ⚠️ Failed to execute: ${err.message}`);
          }

          break; // move to next BUY after successful match
        }
      }
    }
  }

  console.log("\n🏁 Done scanning for matches.\n");
}

// ===================================================
// 🔹 Monitor Loop
// ===================================================
async function monitorOrders(intervalMs = 10_000) {
  console.log("🔎 Order monitor started...");
  while (true) {
    try {
      await tryInternalMatches();
    } catch (err) {
      console.error("🚨 Loop error:", err.message);
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

monitorOrders();

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
const FACTORY_ADDRESS = "0x83DEFEcaF6079504E2DD1DE2c66DCf3046F7bDD7"; // UniswapV3Factory
const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"
];

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
