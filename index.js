// ==========================
// Unified AMM + Order Monitor Backend
// ==========================
import express from "express";
import { ethers } from "ethers";
import { createRequire } from "module";
import dotenv from "dotenv";
import axios from "axios";
import cors from "cors";

dotenv.config();
const require = createRequire(import.meta.url);

// =============== Original Imports ===============
const ABI = require("./ABI/ABI.json");
const POOL_ABI = require("./ABI/PoolABI.json");
import { FACTORY_ABI, FACTORY_ADDRESS } from "./constants.js";

// =============== Shared Provider Setup ===============
const RPC_URL = "https://api.skyhighblockchain.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const FIXED_FEE = 500;
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// =============== Executor Contract ===============
const EXECUTOR_ADDRESS = "0x230eb7155cD2392b8113fE5B557f9F05A81Df9Cd";
const executor = new ethers.Contract(EXECUTOR_ADDRESS, ABI.abi, wallet);

// ===================================================
// 🔁 Order Monitoring Logic
// ===================================================
async function getCurrentRatio(tokenA, tokenB) {
    const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
    const poolAddress = await factory.getPool(tokenA, tokenB, FIXED_FEE);
    if (poolAddress === ethers.ZeroAddress) throw new Error("Pool not found");

    const poolContract = new ethers.Contract(poolAddress, POOL_ABI.abi, provider);
    const slot0 = await poolContract.slot0();
    const token0 = await poolContract.token0();

    const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96);
    const priceX192 = sqrtPriceX96 * sqrtPriceX96;
    const price = Number(priceX192) / Number(1n << 192n);

    return token0.toLowerCase() === tokenA.toLowerCase() ? price : 1 / price;
}

async function monitorOrders(intervalMs = 10000) {
    console.log("🔎 Order monitor started...");

    while (true) {
        try {
            const nextId = Number(await executor.nextOrderId());
            console.log(`📌 Checking ${nextId - 1} orders`);

            for (let orderId = 1; orderId < nextId; orderId++) {
                try {
                    const order = await executor.getOrder(orderId);
                    if (order.filled || order.cancelled) continue;
                    if (Number(order.expiry) < Math.floor(Date.now() / 1000)) continue;

                    const currentRatio = await getCurrentRatio(order.tokenIn, order.tokenOut);
                    const targetRatio = Number(ethers.formatUnits(order.targetSqrtPriceX96, 18));

                    const isBuy = !order.triggerAbove; // usually BUY = triggerBelow, SELL = triggerAbove

                    let conditionMet = false;
                    if (isBuy) {
                        // BUY: execute when price drops down to or below target
                        conditionMet = currentRatio <= targetRatio;
                    } else {
                        // SELL: execute when price rises up to or above target
                        conditionMet = currentRatio >= targetRatio;
                    }

                    console.log(
                        `Order ${orderId} | Current: ${currentRatio.toFixed(6)} | Target: ${targetRatio.toFixed(6)} | Met: ${conditionMet}`
                    );

                    if (conditionMet) {
                        console.log(`⚡ Executing order ${orderId}...`);
                        const tx = await executor.executeOrder(orderId, { gasLimit: 500000 });
                        console.log(`⛽ Tx sent: ${tx.hash}`);
                        const receipt = await tx.wait();
                        console.log(`✅ Order ${orderId} executed in block ${receipt.blockNumber}`);
                    }
                } catch (err) {
                    console.error(`❌ Error processing order ${orderId}:`, err.message);
                }
            }
        } catch (err) {
            console.error("🚨 Monitor error:", err.message);
        }

        await new Promise((res) => setTimeout(res, intervalMs));
    }
}

monitorOrders();

// ===================================================
// 🌐 Express Server Setup
// ===================================================
const app = express();
app.use(cors({ origin: "*" }));
const PORT = process.env.PORT || 4000;

app.get("/", (req, res) => {
    res.json({ status: "ok", executor: EXECUTOR_ADDRESS });
});

app.get("/order/:id", async (req, res) => {
    try {
        const order = await executor.getOrder(req.params.id);
        res.json(order);
    } catch (err) {
        res.status(500).json({ error: err.message });
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
