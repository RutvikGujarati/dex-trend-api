import express from "express";
import { ethers } from "ethers";
import { createRequire } from "module";
import dotenv from "dotenv";
dotenv.config();
const require = createRequire(import.meta.url);

const ABI = require("./ABI.json");
const POOL_ABI = require("./PoolABI.json");
import { FEE_TIERS, FACTORY_ABI, FACTORY_ADDRESS } from "./constants.js";

const RPC_URL = "https://api.skyhighblockchain.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// executor contract
const EXECUTOR_ADDRESS = "0xB25202f5748116bC5A5e9eB3fCaBC7d5b5777996";
const executor = new ethers.Contract(EXECUTOR_ADDRESS, ABI.abi, wallet);

// pool helpers
async function getPoolInfo(tokenA, tokenB, fee) {
    const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
    const poolAddress = await factory.getPool(tokenA, tokenB, fee);

    if (poolAddress === ethers.ZeroAddress) return null;
    const poolContract = new ethers.Contract(poolAddress, POOL_ABI.abi, provider);
    const [slot0Data, liquidity, token0, token1] = await Promise.all([
        poolContract.slot0(),
        poolContract.liquidity(),
        poolContract.token0(),
        poolContract.token1(),
    ]);

    return {
        address: poolAddress,
        fee,
        liquidity: liquidity.toString(),
        sqrtPriceX96: slot0Data.sqrtPriceX96.toString(),
        token0,
        token1,
    };
}

async function getTokenRatio(tokenA, tokenB, fee) {
    const poolInfo = await getPoolInfo(tokenA, tokenB, fee);
    if (!poolInfo) throw new Error("Pool not found");

    const sqrtPriceX96 = BigInt(poolInfo.sqrtPriceX96);
    const priceX192 = sqrtPriceX96 * sqrtPriceX96; // Q128.192
    const price = Number(priceX192) / Number(1n << 192n);

    const decimalsA = 6;
    const decimalsB = 6;

    let ratio;
    if (poolInfo.token0.toLowerCase() === tokenA.toLowerCase()) {
        ratio = price * 10 ** (decimalsA - decimalsB);
    } else {
        ratio = (1 / price) * 10 ** (decimalsB - decimalsA);
    }

    return ratio;
}
const USDC = "0x654684135feea7fd632754d05e15f9886ec7bf28";
const USDT = "0x8df8262960065c242c66efd42eacfb6ad971f962";
// main monitor
async function monitorOrders(intervalMs = 10000) {
    console.log("🔎 Order monitor started...");

    while (true) {
        try {
            const ratio = await getTokenRatio(USDC, USDT, 500); 
            console.log(`💱 USDC/USDT ratio: ${ratio}`);
            const nextIdBN = await executor.nextOrderId();
            const nextId = Number(nextIdBN);

            console.log(`📌 Checking ${nextId - 1} potential orders`);

            for (let orderId = 1; orderId < nextId; orderId++) {
                try {
                    const ord = await executor.getOrder(orderId);

                    if (ord.filled) {
                        console.log(`⏭️  Order ${orderId} already filled`);
                        continue;
                    }
                    if (ord.cancelled) {
                        console.log(`⏭️  Order ${orderId} cancelled`);
                        continue;
                    }
                    if (Number(ord.expiry) < Math.floor(Date.now() / 1000)) {
                        console.log(`⏭️  Order ${orderId} expired`);
                        continue;
                    }

                    // fetch current pool sqrtPrice
                    const poolInfo = await getPoolInfo(ord.tokenIn, ord.tokenOut, ord.poolFee);
                    if (!poolInfo) {
                        console.log(`⚠️  No pool found for order ${orderId}`);
                        continue;
                    }

                    const currentRatio = await getTokenRatio(ord.tokenIn, ord.tokenOut, ord.poolFee);
                    const targetRatio = Number(ord.targetSqrtPriceX96) / 1e18; // store target scaled 1e18
                    const cond = ord.triggerAbove ? currentRatio >= targetRatio : currentRatio <= targetRatio;

                    console.log(
                        `Order ${orderId} | CurrentRatio=${currentRatio} | Target=${targetRatio} | ConditionMet=${cond}`
                    );

                    if (cond) {
                        console.log(`✅ Executing order ${orderId}...`);
                        const tx = await executor.executeOrder(orderId, { gasLimit: 500000 });
                        console.log(`⛽ Tx sent: ${tx.hash}`);
                        const receipt = await tx.wait();
                        console.log(`🎉 Order ${orderId} executed in block ${receipt.blockNumber}`);
                    }
                } catch (innerErr) {
                    console.error(`❌ Error processing order ${orderId}:`, innerErr.message);
                }
            }
        } catch (err) {
            console.error("🚨 Monitor error (outer loop):", err.message);
        }

        await new Promise((res) => setTimeout(res, intervalMs)); // poll interval
    }
}


// start monitor in background
monitorOrders();

// --- Express server ---
const app = express();
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

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
