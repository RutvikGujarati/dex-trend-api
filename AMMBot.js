import { ethers } from "ethers";
import dotenv from "dotenv";
import axios from "axios";
import { createRequire } from "module";
import { TOKENS, COINGECKO_IDS } from "./constants.js";

dotenv.config();
const require = createRequire(import.meta.url);

const EXECUTOR_ABI = require("./ABI/LimitOrder.json");
const ERC20_ABI = require("./ABI/IERC20.json").abi;
const ROUTER_ABI = require("./ABI/RouterABI.json").abi;

const { RPC_URL, PRIVATE_KEY } = process.env;
const EXECUTOR_ADDRESS = "0x14e904F5FfA5748813859879f8cA20e487F407D8";
const UNISWAP_ROUTER = "0x459A438Fbe3Cb71f2F8e251F181576d5a035Faef";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const executor = new ethers.Contract(EXECUTOR_ADDRESS, EXECUTOR_ABI, wallet);
const router = new ethers.Contract(UNISWAP_ROUTER, ROUTER_ABI, wallet);

// Fixed trade amounts per token
const FIXED_TRADE_AMOUNTS = {
    BTC: 0.001,
    ETH: 0.001,
    BNB: 0.001,
};

async function getDecimals(t) {
    return Number(await new ethers.Contract(t, ERC20_ABI, provider).decimals());
}

async function balanceOf(t) {
    return await new ethers.Contract(t, ERC20_ABI, provider).balanceOf(wallet.address);
}

async function approveIfNeeded(token, spender, amt) {
    const c = new ethers.Contract(token, ERC20_ABI, wallet);
    const allowance = await c.allowance(wallet.address, spender);
    if (allowance < amt) {
        const tx = await c.approve(spender, ethers.MaxUint256);
        await tx.wait();
    }
}

function safeNum(v) {
    if (!v || isNaN(v) || !isFinite(v)) return null;
    return Number(v);
}

function encodePrice(p) {
    return ethers.parseUnits(p.toFixed(4), 18);
}

async function swapFor(tokenNeeded, amountNeeded) {
    const usdt = TOKENS.USDT;
    const bal = await balanceOf(usdt);
    if (bal < amountNeeded) return false;
    await approveIfNeeded(usdt, UNISWAP_ROUTER, amountNeeded);
    try {
        const tx = await router.exactInputSingle({
            tokenIn: usdt,
            tokenOut: tokenNeeded,
            fee: 500,
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 900,
            amountIn: amountNeeded,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        }, { gasLimit: 500000 });
        await tx.wait();
        return true;
    } catch {
        return false;
    }
}

async function ensureBalance(token, requiredAmount) {
    const bal = await balanceOf(token);
    if (bal >= requiredAmount) return true;
    const shortage = requiredAmount - bal;
    if (token !== TOKENS.USDT) {
        const usdtNeeded = shortage * 110n / 100n;
        return await swapFor(token, usdtNeeded);
    }
    return false;
}

async function createOrder({ tokenIn, tokenOut, amountIn, amountOutMin, price, orderType }) {
    const hasBalance = await ensureBalance(tokenIn, amountIn);
    if (!hasBalance) return null;
    await approveIfNeeded(tokenIn, EXECUTOR_ADDRESS, amountIn);
    const ttl = 3 * 86400;
    const p1e18 = encodePrice(price);
    const nextId = Number(await executor.nextOrderId());
    try {
        const tx = await executor.depositAndCreateOrder(
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            p1e18,
            ttl,
            orderType,
            { gasLimit: 700000 }
        );
        const rc = await tx.wait();
        return nextId;
    } catch {
        return null;
    }
}

async function getOnchainPrice(a, b) {
    try {
        const [p] = await executor.getLastExecutedPrice(a, b);
        if (p > 0) return Number(ethers.formatUnits(p, 18));
        return null;
    } catch {
        return null;
    }
}

async function getMarketPrices() {
    try {
        const ids = Object.values(COINGECKO_IDS).join(",");
        const r = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
        const out = {};
        for (const [sym, id] of Object.entries(COINGECKO_IDS)) {
            const price = r.data[id]?.usd;
            out[sym] = safeNum(price);
        }
        return out;
    } catch {
        return null;
    }
}

async function setPriceFromLive(symbol, tokenA, market) {
    const USDT = TOKENS.USDT;

    let livePrice;
    if (symbol === "USDE") {
        livePrice = 1;
        console.log(`\n=== ${symbol} PRICE FIXED TO 1 ===`);
    } else {
        livePrice = market[symbol];
    }

    if (!livePrice) {
        console.log(`❌ No price found for ${symbol}`);
        return;
    }

    let obPrice = await getOnchainPrice(tokenA, USDT);
    if (!obPrice) obPrice = livePrice;

    const diff = Math.abs(livePrice - obPrice) / obPrice;

    console.log(`\n=== ${symbol} PRICE CHECK ===`);
    console.log("Live:", livePrice);
    console.log("Onchain:", obPrice);
    console.log(`Diff: ${(diff * 100).toFixed(2)}%`);

    if (diff < 0.01) {
        console.log("❌ Difference < 1% → Skip update");
        return;
    }

    console.log("✅ Difference ≥ 1% → Updating price");

    const targetPrice = livePrice;

    // Use fixed trade amount for this token
    const TRADE_TOKEN_AMOUNT = FIXED_TRADE_AMOUNTS[symbol] || 1;

    const decA = await getDecimals(tokenA);
    const decU = await getDecimals(USDT);

    const amountToken = ethers.parseUnits(TRADE_TOKEN_AMOUNT.toString(), decA);
    const amountUSDT = ethers.parseUnits((TRADE_TOKEN_AMOUNT * targetPrice).toFixed(6), decU);

    const minOutA = amountToken;
    const minOutU = amountUSDT;

    console.log("Trade amount (FIXED):", TRADE_TOKEN_AMOUNT);
    console.log("Token amount:", TRADE_TOKEN_AMOUNT);
    console.log("USDT amount:", (TRADE_TOKEN_AMOUNT * targetPrice).toFixed(6));

    console.log("Creating BUY...");
    const buyId = await createOrder({
        tokenIn: USDT,
        tokenOut: tokenA,
        amountIn: amountUSDT,
        amountOutMin: minOutA,
        price: targetPrice,
        orderType: 0
    });

    if (!buyId && buyId !== 0) {
        console.log("❌ BUY creation failed");
        return;
    }

    console.log("Creating SELL...");
    const sellId = await createOrder({
        tokenIn: tokenA,
        tokenOut: USDT,
        amountIn: amountToken,
        amountOutMin: minOutU,
        price: targetPrice,
        orderType: 1
    });

    if (!sellId && sellId !== 0) {
        console.log("❌ SELL creation failed");
        return;
    }

    console.log("✔ BUY + SELL submitted successfully");
}

async function main() {
    const market = await getMarketPrices();
    if (!market) return;
    for (const [symbol, token] of Object.entries(TOKENS)) {
        if (symbol !== "USDT") {
            await setPriceFromLive(symbol, token, market);
        }
    }
}

main();
setInterval(main, 300000);