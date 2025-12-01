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
const EXECUTOR_ADDRESS = "0x14e904F5FfA5748813859879f8cA20e487F407D8"
const UNISWAP_ROUTER = "0x459A438Fbe3Cb71f2F8e251F181576d5a035Faef"

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const executor = new ethers.Contract(EXECUTOR_ADDRESS, EXECUTOR_ABI, wallet);
const router = new ethers.Contract(UNISWAP_ROUTER, ROUTER_ABI, wallet);

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
        console.log(`Approving ${token}...`);
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

    if (bal < amountNeeded) {
        console.log("Not enough USDT to swap");
        return false;
    }

    console.log(`Swapping USDT → ${tokenNeeded} amount=${ethers.formatUnits(amountNeeded, 6)}`);

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
        console.log("Swap completed successfully");
        return true;
    } catch (e) {
        console.log("Swap failed:", e.message);
        return false;
    }
}

async function ensureBalance(token, requiredAmount) {
    const bal = await balanceOf(token);

    if (bal >= requiredAmount) {
        console.log(`Sufficient balance: ${ethers.formatUnits(bal, await getDecimals(token))}`);
        return true;
    }

    const shortage = requiredAmount - bal;
    console.log(`Balance low. Need: ${ethers.formatUnits(requiredAmount, await getDecimals(token))}, Have: ${ethers.formatUnits(bal, await getDecimals(token))}`);

    // If token is not USDT, swap USDT for it
    if (token !== TOKENS.USDT) {
        // Estimate USDT needed (add 10% buffer for slippage)
        const usdtNeeded = shortage * 110n / 100n;
        return await swapFor(token, usdtNeeded);
    }

    console.log("Insufficient USDT balance");
    return false;
}

async function createOrder({ tokenIn, tokenOut, amountIn, amountOutMin, price, orderType }) {
    console.log(`Creating ${orderType === 0 ? 'BUY' : 'SELL'} order at price=${price}`);

    // Ensure we have enough balance, swap if needed
    const hasBalance = await ensureBalance(tokenIn, amountIn);
    if (!hasBalance) {
        console.log("Failed to ensure sufficient balance");
        return null;
    }

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
        console.log(`Order ${nextId} created at tx: ${rc.transactionHash}`);
        return nextId;
    } catch (e) {
        console.log(`Order creation failed: ${e.message}`);
        return null;
    }
}

async function matchOrders(buyId, sellId) {
    console.log(`Matching BUY ${buyId} + SELL ${sellId}`);

    try {
        const tx = await executor.matchOrders(buyId, sellId, { gasLimit: 700000 });
        const rc = await tx.wait();
        console.log("Match success:", rc.transactionHash);
        return true;
    } catch (e) {
        console.log("Match failed:", e.message);
        return false;
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

        console.log("Market prices:", out);
        return out;

    } catch (e) {
        console.log("Price fetch error:", e.message);
        return null;
    }
}

async function setPriceFromLive(symbol, tokenA, market) {
    const USDT = TOKENS.USDT;

    // LIVE MARKET PRICE AS TARGET PRICE
    const livePrice = market[symbol];
    if (!livePrice) {
        console.log(`No live price for ${symbol}`);
        return;
    }

    // GET ONCHAIN PRICE
    let obPrice = await getOnchainPrice(tokenA, USDT);
    if (!obPrice) obPrice = livePrice;

    // DIFFERENCE CHECK
    const diff = Math.abs(livePrice - obPrice) / obPrice;

    console.log(`\n=== ${symbol} PRICE CHECK ===`);
    console.log("Live:", livePrice);
    console.log("Onchain:", obPrice);
    console.log(`Diff: ${(diff * 100).toFixed(2)}%`);

    // ONLY UPDATE IF DIFFERENCE >= 1%
    if (diff < 0.01) {
        console.log("❌ Difference < 1% → SKIPPING update");
        return;
    }

    console.log("✅ Difference >= 1% → Adjusting price");

    const targetPrice = livePrice;

    // CONSTANT TRADE SIZE
    const tradeAmount = 0.00001;

    const decA = await getDecimals(tokenA);
    const decU = await getDecimals(USDT);

    const amountToken = ethers.parseUnits(tradeAmount.toFixed(6), decA);
    const amountUSDT = ethers.parseUnits((tradeAmount * targetPrice).toFixed(6), decU);

    const minOutA = amountToken * 99n / 100n;
    const minOutU = amountUSDT * 99n / 100n;

    console.log(`Trade amount: ${tradeAmount} ${symbol}`);
    console.log(`USDT amount: ${(tradeAmount * targetPrice).toFixed(6)}`);

    // BUY (USDT -> Token)
    console.log("Creating BUY...");
    const buyId = await createOrder({
        tokenIn: USDT,
        tokenOut: tokenA,
        amountIn: amountUSDT,
        amountOutMin: minOutA,
        price: targetPrice,
        orderType: 0
    });

    if (buyId == null) {
        console.log("BUY order failed");
        return;
    }

    // SELL (Token -> USDT)
    console.log("Creating SELL...");
    const sellId = await createOrder({
        tokenIn: tokenA,
        tokenOut: USDT,
        amountIn: amountToken,
        amountOutMin: minOutU,
        price: targetPrice,
        orderType: 1
    });

    if (sellId == null) {
        console.log("SELL order failed");
        return;
    }

    console.log("✔ BUY + SELL submitted (will match automatically)");
}



async function main() {
    console.log("\n=== BOT CYCLE START ===");

    const market = await getMarketPrices();
    if (!market) {
        console.log("Could not fetch prices");
        return;
    }

    for (const [symbol, token] of Object.entries(TOKENS)) {
        if (symbol !== "USDT") {
            await setPriceFromLive(symbol, token, market);
        }
    }

    console.log("=== BOT CYCLE END ===\n");
}

main();

setInterval(main, 7200000);