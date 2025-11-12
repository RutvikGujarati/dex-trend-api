import { ethers } from "ethers";
import dotenv from "dotenv";
import axios from "axios";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
dotenv.config();

// ===== ABIs =====
const POOL_ABI = require("./ABI/PoolABI.json").abi;
const ERC20_ABI = require("./ABI/IERC20.json").abi;
const EXECUTOR_ABI = require("./ABI/LimitOrder.json");
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns(address)"];

// ===== ENV CONFIG =====
const {
    RPC_URL,
    PRIVATE_KEY,
    FACTORY_ADDRESS,
    EXECUTOR_ADDRESS, // ✅ Add executor address to .env
} = process.env;

if (!RPC_URL || !PRIVATE_KEY || !FACTORY_ADDRESS || !EXECUTOR_ADDRESS)
    throw new Error("Missing .env vars (need RPC_URL, PRIVATE_KEY, FACTORY_ADDRESS, EXECUTOR_ADDRESS)");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
const executor = new ethers.Contract(EXECUTOR_ADDRESS, EXECUTOR_ABI, wallet);

const TOKENS = {
    USDT: "0xC26efb6DB570DEE4BD0541A1ed52B590F05E3E3B",
    ETH: "0xc671a7a0Bcef13018B384F5af9f4696Aba5Ff0F1",
};
const FEE = 500;

// =============== HELPERS ===============

async function getTokenInfo(token) {
    const c = new ethers.Contract(token, ERC20_ABI, provider);
    const [decimals, symbol] = await Promise.all([c.decimals(), c.symbol()]);
    return { decimals: Number(decimals), symbol };
}

async function getPoolData(tA, tB) {
    const addr = await factory.getPool(tA, tB, FEE);
    if (addr === ethers.ZeroAddress) return null;
    const pool = new ethers.Contract(addr, POOL_ABI, provider);
    const [t0, t1, slot0, liquidityBN] = await Promise.all([
        pool.token0(),
        pool.token1(),
        pool.slot0(),
        pool.liquidity(),
    ]);
    const sqrtPriceX96 = BigInt(slot0[0].toString());
    const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
    const price = sqrtPrice ** 2;
    return { poolAddr: addr, token0: t0, token1: t1, price, sqrtPrice, liquidity: Number(liquidityBN) };
}

function encodePriceSqrt(price) {
    const sqrt = Math.sqrt(price);
    const Q96 = 2 ** 96;
    return BigInt(Math.floor(sqrt * Q96)); // uint160
}

async function approve(token, spender, amount = ethers.MaxUint256) {
    const c = new ethers.Contract(token, ERC20_ABI, wallet);
    const allowed = await c.allowance(wallet.address, spender);
    if (allowed < amount) {
        console.log(`  ✓ Approving ${token.slice(0, 8)}...`);
        const tx = await c.approve(spender, amount);
        await tx.wait();
    }
}

// =============== MARKET PRICE ===============
async function getMarketPrices() {
    try {
        const res = await axios.get(
            "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,tether&vs_currencies=usd"
        );
        return {
            ETH: res.data.ethereum.usd,
            USDT: res.data.tether.usd,
        };
    } catch (err) {
        console.error("⚠ Market price fetch failed:", err.message);
        return null;
    }
}

// =============== ORDER CREATION ===============

async function createLimitOrder({
    tokenIn,
    tokenOut,
    amountInHuman,
    priceTarget,
    orderType, // 0 BUY, 1 SELL
    triggerAbove,
}) {
    const infoIn = await getTokenInfo(tokenIn);
    const pool = await factory.getPool(tokenIn, tokenOut, FEE);
    if (pool === ethers.ZeroAddress) throw new Error("Pool not found");

    const decimalsIn = infoIn.decimals;
    const amountIn = ethers.parseUnits(amountInHuman.toString(), decimalsIn);

    const targetSqrtPriceX96 = encodePriceSqrt(priceTarget);
    const ttlSeconds = 600; // 10 min expiry
    const amountOutMin = amountIn / 100n; // allow 1% slippage

    await approve(tokenIn, EXECUTOR_ADDRESS, amountIn);

    console.log(
        `📝 Creating ${orderType === 0 ? "BUY" : "SELL"} order for ${infoIn.symbol}, targetPrice=${priceTarget}`
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
    console.log(`✅ Order created, tx: ${receipt.hash}`);
}

// =============== REBALANCING LOGIC ===============

async function rebalance(tA, tB, marketPrice) {
    const [infoA, infoB] = await Promise.all([getTokenInfo(tA), getTokenInfo(tB)]);
    console.log(`\n📊 Checking ${infoA.symbol}/${infoB.symbol}`);

    const pd = await getPoolData(tA, tB);
    if (!pd) {
        console.log(`⚠ No pool found`);
        return;
    }

    const poolPrice = pd.token0.toLowerCase() === tA.toLowerCase() ? pd.price : 1 / pd.price;
    const targetPrice = marketPrice[infoA.symbol] / marketPrice[infoB.symbol];
    const lower = targetPrice * 0.99;
    const upper = targetPrice * 1.01;

    console.log(
        `  Pool: ${poolPrice.toFixed(6)} | Market: ${targetPrice.toFixed(6)} | Range: [${lower.toFixed(
            6
        )}, ${upper.toFixed(6)}]`
    );

    if (poolPrice >= lower && poolPrice <= upper) {
        console.log(`  ✓ In range, no order created.`);
        return;
    }

    // Decide order type
    const orderType = poolPrice < targetPrice ? 0 : 1; // 0 = BUY (expect price to go up), 1 = SELL
    const triggerAbove = orderType === 0 ? false : true;

    // Small test order (0.01)
    const amountIn = "0.01";

    await createLimitOrder({
        tokenIn: orderType === 0 ? TOKENS.USDT : TOKENS.ETH,
        tokenOut: orderType === 0 ? TOKENS.ETH : TOKENS.USDT,
        amountInHuman: amountIn,
        priceTarget: targetPrice,
        orderType,
        triggerAbove,
    });
}

// =============== MAIN LOOP ===============
async function main() {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`⏰ ${new Date().toLocaleTimeString()}`);
    console.log(`${"=".repeat(60)}`);

    const market = await getMarketPrices();
    if (!market) return;

    await rebalance(TOKENS.ETH, TOKENS.USDT, market);
}

main();
setInterval(main, 60_000);
