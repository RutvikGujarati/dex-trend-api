import { ethers } from "ethers";
import dotenv from "dotenv";
import { createRequire } from "module";

dotenv.config();
const require = createRequire(import.meta.url);

// Your external import (do NOT recreate it here)
import { TOKENS } from "./constants.js";

const EXECUTOR_ABI = require("./ABI/LimitOrder.json");

const { RPC_URL, PRIVATE_KEY, EXECUTOR_ADDRESS } = process.env;

if (!RPC_URL || !PRIVATE_KEY || !EXECUTOR_ADDRESS)
    throw new Error("Missing .env values");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const executor = new ethers.Contract(EXECUTOR_ADDRESS, EXECUTOR_ABI, wallet);

console.log("💼 Wallet:", wallet.address);

const USDT = TOKENS.USDT;

// ===============================================
// CHECK IF ORDER IS OPEN (accurate for your struct)
// ===============================================
async function isOrderOpen(id) {
    try {
        const o = await executor.getOrder(id);

        if (o.maker.toLowerCase() !== wallet.address.toLowerCase()) return false;
        if (o.cancelled) return false;
        if (o.filled) return false;
        if (o.claimed) return false;
        if (o.amountIn === 0n) return false;
        if (Date.now() / 1000 >= Number(o.expiry)) return false;

        return true;
    } catch (err) {
        console.log(`⚠️ getOrder(${id}) failed:`, err.message);
        return false;
    }
}

// ===============================================
// FETCH ALL USDT-PAIR ORDERS FOR THIS WALLET
// ===============================================
async function getUSDTOrders() {
    console.log("🔎 Scanning OrderCreated logs for USDT pairs...");

    const filter = executor.filters.OrderCreated();
    const logs = await executor.queryFilter(filter, 0, "latest");

    const my = wallet.address.toLowerCase();
    const ids = [];

    for (const ev of logs) {
        const a = ev.args;
        if (!a) continue;

        if (a.maker.toLowerCase() !== my) continue;

        const id = Number(a.orderId ?? a.id ?? a[0]);

        // USDT pairs only
        const tIn = a.tokenIn.toLowerCase();
        const tOut = a.tokenOut.toLowerCase();

        if (tIn === USDT.toLowerCase() || tOut === USDT.toLowerCase()) {
            ids.push(id);
        }
    }

    return [...new Set(ids)].sort((a, b) => a - b);
}

// ===============================================
// CANCEL ALL OPEN USDT PAIR ORDERS
// ===============================================
async function cancelUSDTOpenOrders() {
    const ids = await getUSDTOrders();
    console.log(`📦 Total USDT-pair orders found: ${ids.length}`);

    const openIds = [];

    for (const id of ids) {
        if (await isOrderOpen(id)) openIds.push(id);
    }

    console.log(`🔥 Open USDT-pair orders to cancel: ${openIds.length}\n`);

    for (const id of openIds) {
        try {
            console.log(`❌ Cancelling #${id}...`);
            const tx = await executor.cancelOrder(id, { gasLimit: 200000n });
            await tx.wait();
            console.log(`   ✅ Cancelled #${id}\n`);
        } catch (err) {
            console.log(`   ⚠️ Failed to cancel #${id}: ${err.message}\n`);
        }
    }

    console.log("🎉 Done — all OPEN USDT-pair orders have been cancelled.\n");
}

// RUN
cancelUSDTOpenOrders().catch(console.error);
