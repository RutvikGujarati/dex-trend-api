import { ethers } from "ethers";
import dotenv from "dotenv";
import { createRequire } from "module";
import { TOKENS } from "./constants.js";
const require = createRequire(import.meta.url);
dotenv.config();

// ===== ABIs =====
const ERC20_ABI = require("./ABI/IERC20.json").abi;
const EXECUTOR_ABI = require("./ABI/LimitOrder.json");
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns(address)"];

// ===== ENV CONFIG =====
const { RPC_URL, PRIVATE_KEY, FACTORY_ADDRESS, EXECUTOR_ADDRESS } = process.env;
if (!RPC_URL || !PRIVATE_KEY || !FACTORY_ADDRESS || !EXECUTOR_ADDRESS)
    throw new Error("Missing .env vars (RPC_URL, PRIVATE_KEY, FACTORY_ADDRESS, EXECUTOR_ADDRESS)");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
console.log("💼 Wallet address:", wallet.address);

const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
const executor = new ethers.Contract(EXECUTOR_ADDRESS, EXECUTOR_ABI, wallet);
const FEE = 500;

function encodeSimplePrice(price) {
    return BigInt(Math.floor(price * 1e18)); // 6 decimals precision
}
function randomAmount(min = 0.1, max = 10) {
    const val = (Math.random() * (max - min) + min).toFixed(4);
    return val.toString();
}

async function approve(token, spender, amount = ethers.MaxUint256) {
    const c = new ethers.Contract(token, ERC20_ABI, wallet);
    const allowed = await c.allowance(wallet.address, spender);
    if (allowed < amount) {
        console.log(`Approving ${token.slice(0, 8)}...`);
        const tx = await c.approve(spender, amount);
        await tx.wait();
        console.log("✓ Approved");
    }
}

async function getDecimals(token) {
    const c = new ethers.Contract(token, ERC20_ABI, provider);
    return Number(await c.decimals());
}

// ===== CREATE ORDER =====
async function createOrder({ tokenIn, tokenOut, amountInHuman, priceTarget, orderType, triggerAbove, ttlDays }) {
    const decimals = await getDecimals(tokenIn);
    const amountIn = ethers.parseUnits(amountInHuman.toString(), decimals);
    const amountOutMin = amountIn / 100n;
    const ttlSeconds = ttlDays * 24 * 60 * 60;

    const pool = await factory.getPool(tokenIn, tokenOut, FEE);
    if (pool === ethers.ZeroAddress) throw new Error("Pool not found");

    await approve(tokenIn, EXECUTOR_ADDRESS, amountIn);

    const targetSqrtPriceX96 = encodeSimplePrice(
        priceTarget,
      
    );
    const tx = await executor.depositAndCreateOrder(
        tokenIn,
        tokenOut,
        pool,
        amountIn,
        amountOutMin,
        targetSqrtPriceX96,
        triggerAbove,
        ttlSeconds,
        orderType,
        { gasLimit: 1_000_000 }
    );
    const receipt = await tx.wait();
    console.log(
        `✅ ${orderType === 0 ? "BUY" : "SELL"} ${tokenIn.slice(0, 8)} @ ${priceTarget} | amount=${amountInHuman} | tx=${receipt.hash}`
    );
}

// ===== MAIN =====
async function main() {
    const orders = [];

    // --- SOL/USDT: 50 BUY below 0.9, 50 SELL above 1 ---
    for (let i = 0; i < 15; i++) {
        const price = 3130 - i * 0.001; // gradually lower buy prices
        orders.push({
            tokenIn: TOKENS.USDT,
            tokenOut: TOKENS.ETH,
            amountInHuman: randomAmount(),
            priceTarget: price,
            orderType: 0, // BUY
            triggerAbove: false,
            ttlDays: 3,
        });
    }
 
    for (let i = 0; i < 15; i++) {
        const price = 3130 + i * 0.001; // gradually higher sell prices
        orders.push({
            tokenIn: TOKENS.ETH,
            tokenOut: TOKENS.USDT,
            amountInHuman: randomAmount(),
            priceTarget: price,
            orderType: 1, // SELL
            triggerAbove: true,
            ttlDays: 3,
        });
    }
   
    console.log(`\n📦 Creating ${orders.length} random orders...`);
    for (const [i, order] of orders.entries()) {
        try {
            console.log(
                `\n#${i + 1} → ${order.orderType === 0 ? "BUY" : "SELL"} @ ${order.priceTarget} | amount=${order.amountInHuman}`
            );
            await createOrder(order);
        } catch (err) {
            console.error(`❌ Failed order #${i + 1}: ${err.message}`);
        }
    }

    console.log("\n✅ All random batch orders submitted.");
}
// ===== CANCEL BUY ORDERS FOR BNB =====
async function cancelAllBNBBuyOrders() {
    console.log("\n🔍 Searching for all BNB BUY orders...");

    // Fetch all OrderCreated events (adjust the block range if needed)
    const filter = executor.filters.OrderCreated();
    const logs = await executor.queryFilter(filter, 0, "latest");

    const walletAddr = wallet.address;
    const bnbAddr = TOKENS.BNB; // you must define TOKENS.BNB address

    const buyOrders = [];

    for (const log of logs) {
        const { orderId, maker, orderType, tokenIn } = log.args;

        if (
            maker === walletAddr &&
            tokenIn === bnbAddr &&
            orderType === 0 // BUY
        ) {
            buyOrders.push(orderId);
        }
    }

    if (buyOrders.length === 0) {
        console.log("⚠ No BNB BUY orders found.");
        return;
    }

    console.log(`🧾 Found ${buyOrders.length} BUY orders for BNB.`);

    // Cancel each one
    for (const id of buyOrders) {
        try {
            console.log(`🚫 Cancelling order ID ${id.toString()}...`);
            const tx = await executor.cancelOrder(id, { gasLimit: 200000 });
            await tx.wait();
            console.log(`✅ Cancelled order #${id.toString()}`);
        } catch (err) {
            console.error(`❌ Failed to cancel #${id.toString()}: ${err.message}`);
        }
    }

    console.log("🏁 All BNB BUY orders cancelled.");
}

// cancelAllBNBBuyOrders();
main();