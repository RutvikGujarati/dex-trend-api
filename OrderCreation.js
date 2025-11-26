// orderBatcher.js
import { ethers } from "ethers";
import dotenv from "dotenv";
import { createRequire } from "module";
import { TOKENS } from "./constants.js";
const require = createRequire(import.meta.url);
dotenv.config();

// ===== ABIs =====
const ERC20_ABI = require("./ABI/IERC20.json").abi;
const EXECUTOR_ABI = require("./ABI/LimitOrder.json");

// ===== ENV CONFIG =====
const { RPC_URL, PRIVATE_KEY, EXECUTOR_ADDRESS } = process.env;
if (!RPC_URL || !PRIVATE_KEY || !EXECUTOR_ADDRESS)
    throw new Error("Missing .env vars (RPC_URL, PRIVATE_KEY, EXECUTOR_ADDRESS)");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
console.log("💼 Wallet:", wallet.address);

const executor = new ethers.Contract(EXECUTOR_ADDRESS, EXECUTOR_ABI, wallet);
const ZERO = ethers.ZeroAddress;

// ===== UTILITIES =====

// Force 6-decimal amounts (tokens)
function toFixed6(input) {
    const n = Number(input);
    if (!isFinite(n) || n <= 0) throw new Error(`Invalid amount: ${input}`);
    return (Math.round(n * 1_000_000) / 1_000_000).toFixed(6);
}

// Force 4-decimal prices
function toFixed4(input) {
    const n = Number(input);
    if (!isFinite(n) || n <= 0) throw new Error(`Invalid price: ${input}`);
    return (Math.round(n * 10_000) / 10_000).toFixed(4);
}

function encodeSimplePrice(value) {
    const n = Number(value);
    if (!isFinite(n) || n <= 0) throw new Error("Invalid price");
    return ethers.parseUnits(n.toString(), 18);
}

// random amount between min/max but forced to 6 decimals
function randomAmount(min = 0.01, max = 0.1) {
    const raw = Math.random() * (max - min) + min;
    return toFixed6(raw);
}

async function getDecimals(token) {
    const c = new ethers.Contract(token, ERC20_ABI, provider);
    return Number(await c.decimals());
}

async function approveIfNeeded(token, spender, requiredAmount) {
    const c = new ethers.Contract(token, ERC20_ABI, wallet);
    const allowed = await c.allowance(wallet.address, spender);
    if (allowed < requiredAmount) {
        console.log(`Approving ${token} → ${spender}...`);
        const tx = await c.approve(spender, ethers.MaxUint256);
        await tx.wait();
        console.log("✓ Approved");
    }
}

/**
 * Create BUY / SELL orders with strictly formatted decimals.
 */
async function createOrder({ tokenIn, tokenOut, amountHuman, priceTarget, orderType, ttlDays = 3 }) {
    const decimalsIn = await getDecimals(tokenIn);
    const decimalsOut = await getDecimals(tokenOut);

    // enforce decimals
    const priceStr = toFixed4(priceTarget);
    const priceNum = Number(priceStr);

    const amountStr = toFixed6(amountHuman);
    const amountNum = Number(amountStr);

    let amountIn, amountOutMin;

    if (orderType === 0) {
        // BUY
        const depositHuman = toFixed6(priceNum * amountNum);
        amountIn = ethers.parseUnits(depositHuman, decimalsIn);

        const outHuman = toFixed6(amountNum * 0.99);
        amountOutMin = ethers.parseUnits(outHuman, decimalsOut);

    } else {
        // SELL
        amountIn = ethers.parseUnits(amountStr, decimalsIn);

        const outHuman = toFixed6(priceNum * amountNum * 0.99);
        amountOutMin = ethers.parseUnits(outHuman, decimalsOut);
    }

    const ttlSeconds = Math.floor(ttlDays * 24 * 60 * 60);

    await approveIfNeeded(tokenIn, EXECUTOR_ADDRESS, amountIn);

    const targetPrice1e18 = encodeSimplePrice(priceNum);

    const tx = await executor.depositAndCreateOrder(
        tokenIn,
        tokenOut,
        amountIn,
        amountOutMin,
        targetPrice1e18,
        ttlSeconds,
        orderType,
        { gasLimit: 850000n }
    );

    const receipt = await tx.wait();
    return { txHash: receipt.transactionHash, blockNumber: receipt.blockNumber };
}

// ===== MAIN =====

async function main() {
    const orders = [];

    // BUY ORDERS
    for (let i = 0; i < 5; i++) {
        const price = toFixed4(0.0074 - i * 0.001);
        orders.push({
            tokenIn: TOKENS.USDT,
            tokenOut: TOKENS.GALA,
            amountHuman: randomAmount(),
            priceTarget: price,
            orderType: 0,
            ttlDays: 3
        });
    }

    // SELL ORDERS
    for (let i = 0; i < 5; i++) {
        const price = toFixed4(0.0074 + i * 0.001);
        orders.push({
            tokenIn: TOKENS.GALA,
            tokenOut: TOKENS.USDT,
            amountHuman: randomAmount(),
            priceTarget: price,
            orderType: 1,
            ttlDays: 3
        });
    }

    console.log(`\n📦 Creating ${orders.length} orders...\n`);

    for (const [i, ord] of orders.entries()) {
        console.log(`#${i + 1} → ${ord.orderType === 0 ? "BUY" : "SELL"} @ ${ord.priceTarget} | amount=${ord.amountHuman}`);
        try {
            const res = await createOrder(ord);
            console.log(`   ✅ Tx: ${res.txHash} (block ${res.blockNumber})\n`);
        } catch (err) {
            console.error(`   ❌ Failed order #${i + 1}:`, err?.message, "\n");
        }
    }

    console.log("✅ Batch done.\n");
}

// ===== CANCEL HELPERS =====

async function cancelAllBuyOrdersForToken(targetTokenIn) {
    console.log("Scanning events...");

    const filter = executor.filters.OrderCreated();
    const logs = await executor.queryFilter(filter, 0, "latest");

    const myAddr = wallet.address.toLowerCase();
    const buyIds = [];

    for (const ev of logs) {
        const a = ev.args || {};
        if (String(a.maker).toLowerCase() !== myAddr) continue;
        if (String(a.tokenIn).toLowerCase() !== String(targetTokenIn).toLowerCase()) continue;

        const type = Number(a.orderType ?? a[6] ?? 0);
        if (type === 0) {
            const id = Number(a.id ?? a.orderId ?? a._orderId ?? a[0]);
            buyIds.push(id);
        }
    }

    console.log(`Found ${buyIds.length} BUY orders to cancel.`);

    for (const id of buyIds) {
        try {
            const tx = await executor.cancelOrder(id, { gasLimit: 200000n });
            await tx.wait();
            console.log("Cancelled", id);
        } catch (err) {
            console.log("Cancel error:", err?.message);
        }
    }
}

// ===== RUN =====
if (process.argv.includes("--cancel-bnb-buys")) {
    cancelAllBuyOrdersForToken(TOKENS.BNB).catch(console.error);
} else {
    main().catch(console.error);
}
