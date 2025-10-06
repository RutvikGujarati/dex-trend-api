import { ethers } from "ethers";
import dotenv from "dotenv";
import { createRequire } from "module";

dotenv.config();
const require = createRequire(import.meta.url);

const POOL_ABI = require("./ABI/PoolABI.json").abi;
const ERC20_ABI = require("./ABI/IERC20.json").abi;
const SWAP_ROUTER_ABI = require("./ABI/RouterABI.json").abi;
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns(address)"];

const { RPC_URL, PRIVATE_KEY, FACTORY_ADDRESS, SWAP_ROUTER_ADDRESS } = process.env;
if (!RPC_URL || !PRIVATE_KEY || !FACTORY_ADDRESS || !SWAP_ROUTER_ADDRESS) {
    throw new Error("Missing env vars");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
const swapRouter = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);

const TOKENS = {
    USDC: "0x2A4c1D209ef13dBB846c7E7421a0B8238D155fFB",
    USDT: "0x188D71EE19cB9976213BBa3867ED5EdAA04e6E78",
    ETH: "0xEc8f91aDD963aF50f9390795DcD2828990308FA5"
};

const CONFIG = {
    [`${TOKENS.USDC}-${TOKENS.USDT}`]: { min: 0.999, max: 1.0007 },
    [`${TOKENS.ETH}-${TOKENS.USDC}`]: { min: 10, max: 11 },
    [`${TOKENS.ETH}-${TOKENS.USDT}`]: { min: 9, max: 11 }
};

const FEE = 500;

async function approve(token, spender, amount = ethers.MaxUint256) {
    const c = new ethers.Contract(token, ERC20_ABI, wallet);
    const allowed = await c.allowance(wallet.address, spender);
    if (allowed < amount) {
        console.log(`  ✓ Approving...`);
        await (await c.approve(spender, amount)).wait();
    }
}

async function getBalance(token) {
    return new ethers.Contract(token, ERC20_ABI, provider).balanceOf(wallet.address);
}

async function getTokenInfo(token) {
    const c = new ethers.Contract(token, ERC20_ABI, provider);
    const [decimals, symbol] = await Promise.all([c.decimals(), c.symbol()]);
    return { decimals: Number(decimals), symbol };
}

async function getPoolData(tA, tB) {
    const addr = await factory.getPool(tA, tB, FEE);
    if (addr === ethers.ZeroAddress) return null;

    const pool = new ethers.Contract(addr, POOL_ABI, provider);
    const [t0, t1, slot0] = await Promise.all([
        pool.token0(), pool.token1(), pool.slot0()
    ]);

    const sqrtPrice = Number(slot0[0].toString());
    const price = (sqrtPrice / 2 ** 96) ** 2;

    return {
        token0: t0,
        token1: t1,
        price: price
    };
}

function calculateSwapAmount(currentPrice, targetPrice, reserveA, reserveB, swapAtoB) {
    if (swapAtoB) {
        const sqrtRatio = Math.sqrt(currentPrice / targetPrice);
        return reserveA * (sqrtRatio - 1) / sqrtRatio;
    } else {
        const sqrtRatio = Math.sqrt(targetPrice / currentPrice);
        return reserveB * (sqrtRatio - 1) / sqrtRatio;
    }
}

async function swap(tIn, tOut, amt, dec) {
    console.log(`  → Swapping ${amt.toFixed(6)} tokens...`);

    const amountIn = ethers.parseUnits(amt.toFixed(dec), dec);
    const balance = await getBalance(tIn);

    if (balance < amountIn) {
        console.log(`  ⚠ Insufficient balance`);
        return false;
    }

    await approve(tIn, SWAP_ROUTER_ADDRESS, amountIn);

    const params = [
        tIn, tOut, FEE, wallet.address,
        Math.floor(Date.now() / 1000) + 600,
        amountIn, 0, 0
    ];

    try {
        const tx = await swapRouter.exactInputSingle(params, { gasLimit: 500_000 });
        const receipt = await tx.wait();
        console.log(`  ✓ Swap done: ${receipt.hash.slice(0, 10)}...`);
        return true;
    } catch (error) {
        console.error(`  ✗ Swap failed: ${error.message}`);
        return false;
    }
}

async function rebalance(tA, tB) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    const key = `${tA}-${tB}`;
    const cfg = CONFIG[key];
    if (!cfg) {
        console.log(`⚠ No config for pair`);
        return;
    }

    const [infoA, infoB] = await Promise.all([getTokenInfo(tA), getTokenInfo(tB)]);
    console.log(`📊 ${infoA.symbol}/${infoB.symbol}`);

    const [balA, balB] = await Promise.all([getBalance(tA), getBalance(tB)]);
    const balANum = Number(ethers.formatUnits(balA, infoA.decimals));
    const balBNum = Number(ethers.formatUnits(balB, infoB.decimals));

    console.log(`  Wallet: ${balANum.toFixed(6)} ${infoA.symbol} | ${balBNum.toFixed(6)} ${infoB.symbol}`);

    const pd = await getPoolData(tA, tB);
    if (!pd) {
        console.log(`⚠ No pool found`);
        return;
    }

    const poolPrice = pd.token0.toLowerCase() === tA.toLowerCase() ? pd.price : 1 / pd.price;

    console.log(`  Pool price: ${poolPrice.toFixed(6)} | Range: [${cfg.min}, ${cfg.max}]`);

    if (poolPrice >= cfg.min && poolPrice <= cfg.max) {
        console.log(`✓ In range`);
        return;
    }

    let targetPrice, swapAmount, tokenIn, tokenOut, decimalsIn;

    if (poolPrice < cfg.min) {
        targetPrice = cfg.min;
        console.log(`📉 Below min → Swap ${infoB.symbol} → ${infoA.symbol}`);
        swapAmount = calculateSwapAmount(poolPrice, targetPrice, balANum, balBNum, false);
        tokenIn = tB;
        tokenOut = tA;
        decimalsIn = infoB.decimals;

        if (swapAmount <= 0 || swapAmount > balBNum) {
            console.log(`  ⚠ Invalid amount: ${swapAmount.toFixed(6)}`);
            return;
        }
    } else {
        targetPrice = cfg.max;
        console.log(`📈 Above max → Swap ${infoA.symbol} → ${infoB.symbol}`);
        swapAmount = calculateSwapAmount(poolPrice, targetPrice, balANum, balBNum, true);
        tokenIn = tA;
        tokenOut = tB;
        decimalsIn = infoA.decimals;

        if (swapAmount <= 0 || swapAmount > balANum) {
            console.log(`  ⚠ Invalid amount: ${swapAmount.toFixed(6)}`);
            return;
        }
    }

    const success = await swap(tokenIn, tokenOut, swapAmount, decimalsIn);

    if (success) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const [newBalA, newBalB] = await Promise.all([getBalance(tA), getBalance(tB)]);
        console.log(`  New: ${ethers.formatUnits(newBalA, infoA.decimals)} ${infoA.symbol} | ${ethers.formatUnits(newBalB, infoB.decimals)} ${infoB.symbol}`);
    }
}

async function main() {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`⏰ ${new Date().toLocaleTimeString()}`);
    console.log("=".repeat(50));
    try {
        await rebalance(TOKENS.USDC, TOKENS.USDT);
        await rebalance(TOKENS.ETH, TOKENS.USDC);
        await rebalance(TOKENS.ETH, TOKENS.USDT);
        console.log(`\n✅ Done`);
    } catch (e) {
        console.error(`\n❌ Error: ${e.message}`);
    }
}

main();
setInterval(main, 60_000);