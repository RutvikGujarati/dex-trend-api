import express from "express";
import { ethers } from "ethers";
import { createRequire } from "module";
import dotenv from "dotenv";
dotenv.config();
const require = createRequire(import.meta.url);

const ABI = require("./ABI/ABI.json");
const POOL_ABI = require("./ABI/PoolABI.json");
import { FACTORY_ABI, FACTORY_ADDRESS } from "./constants.js";

const RPC_URL = "https://api.skyhighblockchain.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const FIXED_FEE = 500; // Fixed fee tier

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Executor contract
const EXECUTOR_ADDRESS = "0x10e9c43B9Fbf78ca0d83515AE36D360110e4331d";
const executor = new ethers.Contract(EXECUTOR_ADDRESS, ABI.abi, wallet);

// Get current price ratio from pool (both tokens have 18 decimals)
async function getCurrentRatio(tokenA, tokenB) {
    const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
    const poolAddress = await factory.getPool(tokenA, tokenB, FIXED_FEE);

    if (poolAddress === ethers.ZeroAddress) {
        throw new Error("Pool not found");
    }

    const poolContract = new ethers.Contract(poolAddress, POOL_ABI.abi, provider);
    const slot0 = await poolContract.slot0();
    const token0 = await poolContract.token0();

    const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96);
    const priceX192 = sqrtPriceX96 * sqrtPriceX96;
    const price = Number(priceX192) / Number(1n << 192n);

    // Return ratio (decimals cancel out since both are 18)
    return token0.toLowerCase() === tokenA.toLowerCase() ? price : 1 / price;
}

// Main monitor loop
async function monitorOrders(intervalMs = 10000) {
    console.log("🔎 Order monitor started...");

    while (true) {
        try {
            const nextId = Number(await executor.nextOrderId());
            console.log(`📌 Checking ${nextId - 1} orders`);

            for (let orderId = 1; orderId < nextId; orderId++) {
                try {
                    const order = await executor.getOrder(orderId);

                    // Skip if filled, cancelled, or expired
                    if (order.filled || order.cancelled) continue;
                    if (Number(order.expiry) < Math.floor(Date.now() / 1000)) continue;

                    // Get current and target ratios
                    const currentRatio = await getCurrentRatio(order.tokenIn, order.tokenOut);
                    const targetRatio = Number(ethers.formatUnits(order.targetSqrtPriceX96, 18));

                    // Check if condition is met
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

// Start monitor
monitorOrders();

// Express API
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