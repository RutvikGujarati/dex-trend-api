import { ethers } from "ethers";
import dotenv from "dotenv";
import axios from "axios";
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
    USDC: "0x553fE3CA2A5F304857A7c2C78b37686716B8c89b",
    USDT: "0xC26efb6DB570DEE4BD0541A1ed52B590F05E3E3B",
    ETH: "0xc671a7a0Bcef13018B384F5af9f4696Aba5Ff0F1"
};

const FEE = 500; // 0.05%

// =============== UTIL FUNCTIONS ===============

async function approve(token, spender, amount = ethers.MaxUint256) {
    const c = new ethers.Contract(token, ERC20_ABI, wallet);
    const allowed = await c.allowance(wallet.address, spender);
    if (allowed < amount) {
        console.log(`  ✓ Approving ${token.slice(0, 8)}...`);
        await (await c.approve(spender, amount)).wait();
    }
}

async function getBalance(token) {
    const c = new ethers.Contract(token, ERC20_ABI, provider);
    return c.balanceOf(wallet.address);
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
    const [t0, t1, slot0, liquidityBN] = await Promise.all([
        pool.token0(),
        pool.token1(),
        pool.slot0(),
        pool.liquidity()
    ]);
    const sqrtPriceX96 = BigInt(slot0[0].toString());
    const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
    const price = sqrtPrice ** 2;
    return { token0: t0, token1: t1, price, sqrtPrice, liquidity: Number(liquidityBN) };
}

// =============== MARKET PRICE FETCHER ===============

async function getMarketPrices() {
    try {
        const res = await axios.get(
            "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,tether,usd-coin&vs_currencies=usd"
        );
        const data = res.data;
        return {
            ETH: data.ethereum.usd,
            USDT: data.tether.usd,
            USDC: data["usd-coin"].usd
        };
    } catch (err) {
        console.error("⚠ Failed to fetch prices", err.message);
        return null;
    }
}

// =============== PRICE CALCULATION LOGIC ===============

function getSwapAmount(pd, tA, targetPrice) {
    const poolToken0 = pd.token0.toLowerCase();
    const tA_l = tA.toLowerCase();
    const targetPricePool = poolToken0 === tA_l ? targetPrice : 1 / targetPrice;

    const s = pd.sqrtPrice;
    const sTarget = Math.sqrt(targetPricePool);
    const L = pd.liquidity;
    if (!isFinite(s) || !isFinite(sTarget) || !isFinite(L) || L <= 0) return null;

    const needToken1 = sTarget > s;
    const tokenIn = needToken1 ? pd.token1 : pd.token0;
    const tokenOut = needToken1 ? pd.token0 : pd.token1;

    // Full theoretical amount
    let amount = needToken1 ? L * (sTarget - s) : L * (1 / sTarget - 1 / s);
    if (amount <= 0) return null;

    const scaleFactor = 1e-18;

    // ✅ Apply a gradual step (e.g., 20% of full amount)
    const STEP = 0.01; // 20% of full swap
    amount = amount * STEP;

    return { tokenIn, tokenOut, amount: amount * scaleFactor };
}


// =============== SWAP ===============

async function swap(tIn, tOut, amt, dec) {
    const amountIn = ethers.parseUnits(amt.toFixed(dec), dec);
    const balance = await getBalance(tIn);
    if (balance < amountIn) {
        console.log(`  ⚠ Not enough balance for ${tIn.slice(0, 8)}`);
        return false;
    }
    await approve(tIn, SWAP_ROUTER_ADDRESS, amountIn);

    const params = [
        tIn,
        tOut,
        FEE,
        wallet.address,
        Math.floor(Date.now() / 1000) + 600,
        amountIn,
        0,
        0
    ];

    try {
        const tx = await swapRouter.exactInputSingle(params, { gasLimit: 500_000 });
        await tx.wait();
        console.log(`  ✓ Swap successful`);
        return true;
    } catch (err) {
        console.error(`  ✗ Swap failed: ${err.message}`);
        return false;
    }
}

// =============== REBALANCING LOGIC ===============
function estimateOutput(amountIn, pd, tokenIn, tokenOut) {
    // Approximation for small swaps using price
    const poolPrice = pd.token0.toLowerCase() === tokenIn.toLowerCase()
        ? pd.price
        : 1 / pd.price;

    if (tokenIn.toLowerCase() === pd.token0.toLowerCase()) {
        // token0 -> token1
        return amountIn * poolPrice;
    } else {
        // token1 -> token0
        return amountIn / poolPrice;
    }
}

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
        console.log(`  ✓ In range`);
        return;
    }

    const swapData = getSwapAmount(pd, tA, targetPrice);
    if (!swapData) {
        console.log(`⚠ Cannot compute swap`);
        return;
    }

    const infoIn =
        swapData.tokenIn.toLowerCase() === tA.toLowerCase() ? infoA : infoB;
    const amt = swapData.amount;

    if (amt <= 0) {
        console.log(`⚠ Invalid amount`);
        return;
    }
    const tokenOut = swapData.tokenOut;
    const estimatedOut = estimateOutput(amt, pd, swapData.tokenIn, tokenOut);

    console.log(
        `  → Swapping ${amt.toFixed(6)} ${swapData.tokenIn === tA ? infoA.symbol : infoB.symbol} ` +
        `→ ${tokenOut} (≈ ${estimatedOut.toFixed(6)} ${tokenOut === tA ? infoA.symbol : infoB.symbol})`
    );
    const success = await swap(swapData.tokenIn, swapData.tokenOut, amt, infoIn.decimals);

    if (!success) return;

    // ✅ Fetch pool data again to confirm change
    const pdAfter = await getPoolData(tA, tB);
    const newPoolPrice =
        pdAfter.token0.toLowerCase() === tA.toLowerCase() ? pdAfter.price : 1 / pdAfter.price;

    const moved = Math.abs(newPoolPrice - targetPrice) < Math.abs(poolPrice - targetPrice);
    console.log(`  📉 Old pool: ${poolPrice.toFixed(6)}`);
    console.log(`  📈 New pool: ${newPoolPrice.toFixed(6)}`);
    console.log(
        moved
            ? `  ✅ Price moved closer to target (${targetPrice.toFixed(6)})`
            : `  ⚠ Price did not move toward target`
    );
}


// =============== MAIN LOOP ===============

async function main() {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`⏰ ${new Date().toLocaleTimeString()}`);
    console.log(`${"=".repeat(60)}`);

    const market = await getMarketPrices();
    if (!market) return;

    await rebalance(TOKENS.ETH, TOKENS.USDC, market);
    await rebalance(TOKENS.ETH, TOKENS.USDT, market);
    await rebalance(TOKENS.USDT, TOKENS.USDC, market);
}

main();
setInterval(main, 60_000);
