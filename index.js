import express from "express";
import { ethers } from "ethers";
import { createRequire } from "module";
import dotenv from "dotenv";
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
const EXECUTOR_ADDRESS = "0x10e9c43B9Fbf78ca0d83515AE36D360110e4331d";
const executor = new ethers.Contract(EXECUTOR_ADDRESS, ABI.abi, wallet);

// =============== Existing Monitor Logic ===============
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

                    const conditionMet = order.triggerAbove
                        ? currentRatio >= targetRatio
                        : currentRatio <= targetRatio;

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

// =============== Express Server ===============
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
// 🧠 AMM BOT SECTION (Directly Embedded)
// ===================================================
const ERC20_ABI = require("./ABI/IERC20.json").abi;

const TOKENS = {
    USDC: "0x2A4c1D209ef13dBB846c7E7421a0B8238D155fFB",
    USDT: "0x188D71EE19cB9976213BBa3867ED5EdAA04e6E78",
    ETH: "0xEc8f91aDD963aF50f9390795DcD2828990308FA5"
};

const CONFIG = {
    [`${TOKENS.USDC}-${TOKENS.USDT}`]: { min: 0.999, max: 1.0007 },
    [`${TOKENS.ETH}-${TOKENS.USDC}`]: { min: 9, max: 12 },
    [`${TOKENS.ETH}-${TOKENS.USDT}`]: { min: 9, max: 12 }
};

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

    // Safe conversion for sqrtPriceX96
    const sqrtPriceX96 = BigInt(slot0[0].toString());
    const sqrtPrice = Number(sqrtPriceX96) / Number(2n ** 96n);
    const price = sqrtPrice ** 2; // token1 per token0
    const tick = Number(slot0[1]);
    const liquidity = Number(liquidityBN);

    // Token decimals
    const [dec0, dec1] = await Promise.all([
        new ethers.Contract(t0, ERC20_ABI, provider).decimals(),
        new ethers.Contract(t1, ERC20_ABI, provider).decimals()
    ]);

    // ⚠ Approximation — Uniswap v3 concentrated liquidity doesn’t map directly to reserves
    const reserve0 = liquidity / sqrtPrice;
    const reserve1 = liquidity * sqrtPrice;

    // Scale to token units
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
async function rebalance(tA, tB) {
    const key = `${tA}-${tB}`;
    const cfg = CONFIG[key];
    if (!cfg) return { error: "No config for pair" };

    const [infoA, infoB, pd] = await Promise.all([
        getTokenInfo(tA),
        getTokenInfo(tB),
        getPoolData(tA, tB)
    ]);

    if (!pd) return { error: "Pool not found" };

    const poolPrice = pd.token0.toLowerCase() === tA.toLowerCase() ? pd.price : 1 / pd.price;
    const inRange = poolPrice >= cfg.min && poolPrice <= cfg.max;
    const side = poolPrice < cfg.min ? "Below" : poolPrice > cfg.max ? "Above" : "In Range";

    // Approximate LP value in ETH
    // We’ll assume:
    // - If ETH is one of the tokens, that’s your reference
    // - If not, we use the USDC/USDT pair assuming 1 USD ≈ 1 / 3000 ETH (you can update this to pull live price)
    let token0ValueETH = 0;
    let token1ValueETH = 0;

    const ETH_ADDRESSES = [
        TOKENS.ETH.toLowerCase(),
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
    ];

    const reserve0 = pd.reserves.token0Reserve;
    const reserve1 = pd.reserves.token1Reserve;

    if (ETH_ADDRESSES.includes(tA.toLowerCase())) {
        token0ValueETH = reserve0;
        token1ValueETH = reserve1 / poolPrice;
    } else if (ETH_ADDRESSES.includes(tB.toLowerCase())) {
        token1ValueETH = reserve1;
        token0ValueETH = reserve0 * poolPrice;
    } else {
        // If both are stable or non-ETH assets, approximate at ETH ≈ 3000 USD
        const ETH_PRICE = 3000;
        token0ValueETH = reserve0 / ETH_PRICE;
        token1ValueETH = reserve1 / ETH_PRICE;
    }

    const totalValueETH = token0ValueETH + token1ValueETH;

    return {
        pair: `${infoA.symbol}/${infoB.symbol}`,
        poolAddress: pd.addr,
        price: poolPrice.toFixed(6),
        range: `[${cfg.min}, ${cfg.max}]`,
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

// AMM endpoints
app.get("/amm/status", async (req, res) => {
    try {
        const pairs = await Promise.all([
            rebalance(TOKENS.USDC, TOKENS.USDT),
            rebalance(TOKENS.ETH, TOKENS.USDC),
            rebalance(TOKENS.ETH, TOKENS.USDT)
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

        const result = await rebalance(tA, tB);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===================================================
app.listen(PORT, () => {
    console.log(`🚀 Unified Server running at http://localhost:${PORT}`);
});
