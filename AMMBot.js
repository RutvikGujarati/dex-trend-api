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

async function adjustPrice(symbol, tokenA, market) {
    const USDT = TOKENS.USDT;

    const real = safeNum(market[symbol] / market["USDT"]);
    if (!real) {
        console.log("Real price invalid for", symbol);
        return;
    }

    let ob = await getOnchainPrice(tokenA, USDT);
    if (!ob) ob = real;

    console.log(`\n=== ${symbol} ===`);
    console.log("Real:", real, "OB:", ob);

    const deviation = Math.abs(real - ob) / ob;
    const MAX_DEV = 0.05; // 5%

    if (deviation < MAX_DEV) {
        console.log("Price within range, skipping");
        return;
    }

    console.log(`Deviation: ${(deviation * 100).toFixed(2)}% - Adjusting...`);

    const execPrice = safeNum(Number(real.toFixed(4)));
    if (!execPrice) {
        console.log("Exec price invalid");
        return;
    }

    // Use meaningful token amounts (0.01 tokens instead of 0.00001)
    const tradeAmount = 0.01;
    const decA = await getDecimals(tokenA);
    const decU = await getDecimals(USDT);

    // Calculate amounts that will match exactly
    const sellAmount = ethers.parseUnits(tradeAmount.toFixed(6), decA);
    const buyAmount = ethers.parseUnits((execPrice * tradeAmount).toFixed(6), decU);
    
    // Set minimum outputs to 99% to allow for small rounding
    const minOutA = sellAmount * 99n / 100n;
    const minOutU = buyAmount * 99n / 100n;

    console.log(`Trade Amount: ${tradeAmount} ${symbol}`);
    console.log(`USDT Amount: ${(execPrice * tradeAmount).toFixed(6)} USDT`);

    // Create BUY order (USDT -> Token)
    console.log("Creating BUY order...");
    const buyId = await createOrder({
        tokenIn: USDT,
        tokenOut: tokenA,
        amountIn: buyAmount,
        amountOutMin: minOutA,
        price: execPrice,
        orderType: 0
    });

    if (!buyId && buyId !== 0) {
        console.log("BUY order creation failed");
        return;
    }

    // Create SELL order (Token -> USDT)
    console.log("Creating SELL order...");
    const sellId = await createOrder({
        tokenIn: tokenA,
        tokenOut: USDT,
        amountIn: sellAmount,
        amountOutMin: minOutU,
        price: execPrice,
        orderType: 1
    });

    if (!sellId && sellId !== 0) {
        console.log("SELL order creation failed");
        return;
    }

    // Match the orders
    const matched = await matchOrders(buyId, sellId);
    
    if (matched) {
        const newP = await getOnchainPrice(tokenA, USDT);
        console.log("Updated Onchain Price:", newP);
        console.log(`Price adjustment successful!`);
    } else {
        console.log("Price adjustment failed - orders did not match");
    }
}

async function main() {
    console.log("\n=== BOT CYCLE START ===");
    console.log(`Time: ${new Date().toISOString()}`);
    
    const market = await getMarketPrices();
    if (!market) {
        console.log("Failed to fetch market prices, skipping cycle");
        return;
    }

    for (const [symbol, token] of Object.entries(TOKENS)) {
        if (symbol !== "USDT") {
            try {
                await adjustPrice(symbol, token, market);
            } catch (e) {
                console.log(`Error adjusting ${symbol}:`, e.message);
            }
        }
    }

    console.log("=== BOT CYCLE COMPLETE ===\n");
}

// Run immediately on start
main();

// Then run every 15 minutes (900000 ms)
setInterval(main, 900000);