// orderBatcher.js
import { ethers } from "ethers";
import dotenv from "dotenv";
import { createRequire } from "module";
import { TOKENS } from "./constants.js"; // ensure this exports token addresses
const require = createRequire(import.meta.url);
dotenv.config();

// ===== ABIs =====
const ERC20_ABI = require("./ABI/IERC20.json").abi;
const EXECUTOR_ABI = require("./ABI/LimitOrder.json");

// ===== ENV CONFIG (set these in your .env) =====
const { RPC_URL, PRIVATE_KEY, EXECUTOR_ADDRESS } = process.env;
if (!RPC_URL || !PRIVATE_KEY || !EXECUTOR_ADDRESS)
    throw new Error("Missing .env vars (RPC_URL, PRIVATE_KEY, EXECUTOR_ADDRESS)");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
console.log("💼 Wallet address:", wallet.address);

const executor = new ethers.Contract(EXECUTOR_ADDRESS, EXECUTOR_ABI, wallet);
const ZERO = ethers.ZeroAddress;

// ===== Utilities =====
function encodeSimplePrice(value) {
    const n = parseFloat(value);
    if (isNaN(n) || n <= 0) throw new Error("Invalid price");
    // price scaled to 1e18
    return ethers.parseUnits(n.toString(), 18);
}
function randomAmount(min = 0.1, max = 1) {
    const val = (Math.random() * (max - min) + min).toFixed(4);
    return val.toString();
}

async function getDecimals(token) {
    const c = new ethers.Contract(token, ERC20_ABI, provider);
    return Number(await c.decimals());
}

async function approveIfNeeded(token, spender, requiredAmount) {
    const c = new ethers.Contract(token, ERC20_ABI, wallet);
    const allowed = await c.allowance(wallet.address, spender);
    // allowed and requiredAmount are BigInt
    if (allowed < requiredAmount) {
        console.log(`Approving ${token.slice(0, 8)} for ${spender}...`);
        const tx = await c.approve(spender, ethers.MaxUint256);
        await tx.wait();
        console.log("✓ Approved");
    }
}

/**
 * Create order using simple CEX-style semantics:
 * - BUY: user pays (price * amount) of quoteToken (tokenIn) and expects `amount` base token (tokenOut)
 * - SELL: user pays `amount` of baseToken (tokenIn) and expects (price * amount) quote token (tokenOut)
 *
 * Params:
 *  - tokenIn, tokenOut: addresses
 *  - amountHuman: amount in human units (base units for SELL, base units for BUY receive)
 *  - priceTarget: price (quote per base), numeric or string
 *  - orderType: 0 = BUY, 1 = SELL
 *  - ttlDays: integer
 */
async function createOrder({ tokenIn, tokenOut, amountHuman, priceTarget, orderType, ttlDays = 3 }) {
    // Determine decimals for tokenIn and tokenOut
    const decimalsIn = await getDecimals(tokenIn);
    const decimalsOut = await getDecimals(tokenOut);

    // Parse numeric inputs
    const priceNum = parseFloat(String(priceTarget));
    const amountNum = parseFloat(String(amountHuman));
    if (isNaN(priceNum) || isNaN(amountNum) || priceNum <= 0 || amountNum <= 0) {
        throw new Error("Invalid price or amount");
    }

    // For BUY: deposit = price * amount (in tokenIn decimals)
    // For SELL: deposit = amount (in tokenIn decimals)
    let amountIn;       // BigInt, in tokenIn smallest units
    let amountOutMin;   // BigInt, in tokenOut smallest units (we set reasonable min)
    if (orderType === 0) {
        // BUY
        // amountInHuman (what user pays in quote) = price * amount
        const depositHuman = priceNum * amountNum;
        amountIn = ethers.parseUnits(depositHuman.toString(), decimalsIn); // tokenIn is quote token
        // amountOutMin: minimum base token expected (we accept exact amount * 0.99 slippage)
        const amountOutHuman = amountNum * 0.99; // 1% slippage tolerance
        amountOutMin = ethers.parseUnits(amountOutHuman.toString(), decimalsOut);
    } else {
        // SELL
        // deposit = amountNum (base units)
        amountIn = ethers.parseUnits(amountNum.toString(), decimalsIn); // tokenIn is base token
        // amountOutMin: minimum quote token expected
        const outHuman = priceNum * amountNum * 0.99; // 1% slippage tolerance
        amountOutMin = ethers.parseUnits(outHuman.toString(), decimalsOut);
    }

    const ttlSeconds = Math.floor(ttlDays * 24 * 60 * 60);

    // Approve tokenIn if needed
    await approveIfNeeded(tokenIn, EXECUTOR_ADDRESS, amountIn);

    // Construct target price scaled to 1e18 (uint256)
    const targetPrice1e18 = encodeSimplePrice(priceNum);

    // Use ZERO pool
    const pool = ZERO;

    // Call contract — ethers v6 requires overrides as last param (gasLimit bigint)
    const tx = await executor.depositAndCreateOrder(
        tokenIn,
        tokenOut,
        pool,
        amountIn,
        amountOutMin,
        targetPrice1e18,
        ttlSeconds,
        orderType,
        { gasLimit: 800000n } // must be bigint
    );

    const receipt = await tx.wait();
    return { txHash: receipt.transactionHash, blockNumber: receipt.blockNumber };
}

// ===== MAIN: create a batch of test orders =====
async function main() {
    const orders = [];

    // Create some BUY orders: tokenIn = USDT (quote), tokenOut = USDC (base)
    for (let i = 0; i < 5; i++) {
        const price = 0.14 - i * 0.001; // 1.000, 0.999, 0.998...
        orders.push({
            tokenIn: TOKENS.USDT,
            tokenOut: TOKENS.MATIC,
            amountHuman: randomAmount(), // base amount they want to receive
            priceTarget: price,
            orderType: 0, // BUY
            ttlDays: 3
        });
    }

    // Create some SELL orders: 
    for (let i = 0; i < 5; i++) {
        const price = 0.14 + i * 0.001;
        orders.push({
            tokenIn: TOKENS.MATIC,
            tokenOut: TOKENS.USDT,
            amountHuman: randomAmount(),
            priceTarget: price,
            orderType: 1, // SELL
            ttlDays: 3
        });
    }

    console.log(`\n📦 Creating ${orders.length} orders...`);

    for (const [i, ord] of orders.entries()) {
        try {
            console.log(`\n#${i + 1} → ${ord.orderType === 0 ? "BUY" : "SELL"} @ ${ord.priceTarget} | amount=${ord.amountHuman}`);
            const res = await createOrder(ord);
            console.log(`   ✅ Tx: ${res.txHash} (block ${res.blockNumber})`);
        } catch (err) {
            console.error(`   ❌ Failed order #${i + 1}:`, err?.message ?? err);
        }
    }

    console.log("\n✅ Batch done.");
}

// Optional helper: cancel all buy orders for a token created by this wallet
async function cancelAllBuyOrdersForToken(targetTokenIn) {
    console.log("🔍 scanning OrderCreated events for our buys...");
    const filter = executor.filters.OrderCreated();
    // queryFilter over entire chain may be slow — adjust range if needed
    const logs = await executor.queryFilter(filter, 0, "latest");
    const myAddr = wallet.address.toLowerCase();

    const buyOrderIds = [];
    for (const ev of logs) {
        const args = ev.args || {};
        // Event fields may be named differently — check your ABI event arg names
        const maker = String(args.maker).toLowerCase();
        const tokenIn = String(args.tokenIn).toLowerCase();
        const id = args.id ?? args.orderId ?? args._orderId ?? args[0]; // try multiple names

        if (maker === myAddr && tokenIn === targetTokenIn.toLowerCase()) {
            // Determine orderType; event may contain it in args
            if (Number(args.orderType ?? args[6] ?? 0) === 0) {
                buyOrderIds.push(Number(id.toString ? id.toString() : id));
            }
        }
    }

    console.log(`Found ${buyOrderIds.length} buy orders to cancel.`);

    for (const id of buyOrderIds) {
        try {
            const tx = await executor.cancelOrder(id, { gasLimit: 200000n });
            await tx.wait();
            console.log(`Cancelled #${id}`);
        } catch (err) {
            console.error(`Failed cancelling #${id}:`, err?.message ?? err);
        }
    }
}

// Run main when script executed
if (process.argv.includes("--cancel-bnb-buys")) {
    // example usage: node orderBatcher.js --cancel-bnb-buys
    cancelAllBuyOrdersForToken(TOKENS.BNB).catch((e) => console.error(e));
} else {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
