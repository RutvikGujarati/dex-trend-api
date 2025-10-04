import { ethers } from "ethers";
import dotenv from "dotenv";
import { createRequire } from "module";
import { Token } from "@uniswap/sdk-core";
import { Pool, Position, nearestUsableTick } from "@uniswap/v3-sdk";

dotenv.config();
const require = createRequire(import.meta.url);

// ABIs
const POOL_ABI = require("./ABI/PoolABI.json").abi;
const PM_ABI = require("./ABI/PositionManagerABI.json").abi;
const ERC20_ABI = require("./ABI/IERC20.json").abi;
const SWAP_ROUTER_ABI = require("./ABI/RouterABI.json").abi
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns(address)"];

// Config
const { RPC_URL, PRIVATE_KEY, FACTORY_ADDRESS, POSITION_MANAGER_ADDRESS, SWAP_ROUTER_ADDRESS } = process.env;
if (!RPC_URL || !PRIVATE_KEY || !FACTORY_ADDRESS || !POSITION_MANAGER_ADDRESS || !SWAP_ROUTER_ADDRESS) {
    throw new Error("Missing env vars");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
const swapRouter = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);

// Tokens & Config
const TOKENS = {
    USDC: "0x2A4c1D209ef13dBB846c7E7421a0B8238D155fFB",
    USDT: "0x188D71EE19cB9976213BBa3867ED5EdAA04e6E78",
    ETH: "0xEc8f91aDD963aF50f9390795DcD2828990308FA5"
};

const CONFIG = {
    [`${TOKENS.USDC}-${TOKENS.USDT}`]: {
        min: 0.999,
        max: 1.0007,
        lpAmountA: "5",  // Fixed amount to add to LP per cycle
        lpAmountB: "5"
    },
    [`${TOKENS.ETH}-${TOKENS.USDC}`]: {
        min: 0.09,
        max: 0.11,
        lpAmountA: "0.01",
        lpAmountB: "0.1"
    },
    [`${TOKENS.ETH}-${TOKENS.USDT}`]: {
        min: 0.09,
        max: 0.11,
        lpAmountA: "0.01",
        lpAmountB: "0.1"
    }
};

const positions = {};
const FEE = 500;
const RESERVE_PERCENTAGE = 0.9; // Keep 90% of balance as reserve, use only 10% for swaps

// Helpers
async function approve(token, spender, amount = ethers.MaxUint256) {
    const c = new ethers.Contract(token, ERC20_ABI, wallet);
    const allowed = await c.allowance(wallet.address, spender);
    if (allowed < amount) {
        console.log(`  ✓ Approving token ${token.slice(0, 6)}...`);
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
    const [t0, t1, slot0, liq] = await Promise.all([
        pool.token0(), pool.token1(), pool.slot0(), pool.liquidity()
    ]);

    return {
        address: addr,
        token0: t0,
        token1: t1,
        sqrtPriceX96: slot0[0],
        tick: Number(slot0[1]),
        liquidity: liq,
        price: (Number(slot0[0].toString()) / 2 ** 96) ** 2
    };
}

// Swap with limited amount
async function swap(tIn, tOut, amt, dec) {
    console.log(`  → Swapping ${amt} tokens...`);

    const amountIn = ethers.parseUnits(amt.toString(), dec);
    const balance = await getBalance(tIn);

    if (balance < amountIn) {
        console.log(`  ⚠ Insufficient balance for swap`);
        return;
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
        const receipt = await tx.wait();
        console.log(`  ✓ Swap done: ${receipt.hash.slice(0, 10)}...`);
        return receipt;
    } catch (error) {
        console.error(`  ✗ Swap failed: ${error.message}`);
        // Try to get revert reason
        if (error.data) {
            console.error(`  Revert data: ${error.data}`);
        }
        throw error;
    }
}

// Mint Position with fixed amounts
async function mintPosition(tA, tB, amtA, amtB) {
    console.log(`  → Minting LP with ${amtA} + ${amtB} tokens...`);
    const pd = await getPoolData(tA, tB);
    if (!pd) throw new Error("No pool");

    const pool = new ethers.Contract(pd.address, POOL_ABI, provider);
    const [spacing, infoA, infoB] = await Promise.all([
        pool.tickSpacing(),
        getTokenInfo(tA),
        getTokenInfo(tB)
    ]);

    const chainId = (await provider.getNetwork()).chainId;
    const tokA = new Token(Number(chainId), tA, infoA.decimals, infoA.symbol);
    const tokB = new Token(Number(chainId), tB, infoB.decimals, infoB.symbol);

    const isT0A = pd.token0.toLowerCase() === tA.toLowerCase();
    const [tok0, tok1] = isT0A ? [tokA, tokB] : [tokB, tokA];

    const sdkPool = new Pool(tok0, tok1, FEE, pd.sqrtPriceX96.toString(), pd.liquidity.toString(), pd.tick);

    const base = nearestUsableTick(pd.tick, Number(spacing));
    const lower = base - Number(spacing) * 20;
    const upper = base + Number(spacing) * 20;

    const rawA = ethers.parseUnits(amtA.toString(), infoA.decimals);
    const rawB = ethers.parseUnits(amtB.toString(), infoB.decimals);
    const [amt0, amt1] = isT0A ? [rawA, rawB] : [rawB, rawA];

    const pos = Position.fromAmounts({
        pool: sdkPool,
        tickLower: lower,
        tickUpper: upper,
        amount0: amt0.toString(),
        amount1: amt1.toString(),
        useFullPrecision: true
    });

    await approve(tok0.address, POSITION_MANAGER_ADDRESS);
    await approve(tok1.address, POSITION_MANAGER_ADDRESS);

    const pm = new ethers.Contract(POSITION_MANAGER_ADDRESS, PM_ABI, wallet);
    const params = {
        token0: tok0.address,
        token1: tok1.address,
        fee: FEE,
        tickLower: lower,
        tickUpper: upper,
        amount0Desired: pos.mintAmounts.amount0.toString(),
        amount1Desired: pos.mintAmounts.amount1.toString(),
        amount0Min: 0,
        amount1Min: 0,
        recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 600
    };

    const tx = await pm.mint(params, { gasLimit: 1_200_000 });
    const receipt = await tx.wait();

    for (const log of receipt.logs) {
        try {
            const parsed = pm.interface.parseLog(log);
            if (parsed.name === "IncreaseLiquidity") {
                const tokenId = parsed.args.tokenId.toString();
                console.log(`  ✓ Position #${tokenId} created`);
                return tokenId;
            }
        } catch { }
    }
    throw new Error("Failed to get tokenId");
}

// Increase with fixed amounts only
async function addFixedLiquidity(tokenId, tA, tB, amtA, amtB) {
    console.log(`  → Adding ${amtA} + ${amtB} to position #${tokenId}...`);

    const [infoA, infoB] = await Promise.all([getTokenInfo(tA), getTokenInfo(tB)]);

    const rawA = ethers.parseUnits(amtA.toString(), infoA.decimals);
    const rawB = ethers.parseUnits(amtB.toString(), infoB.decimals);

    await approve(tA, POSITION_MANAGER_ADDRESS);
    await approve(tB, POSITION_MANAGER_ADDRESS);

    const pm = new ethers.Contract(POSITION_MANAGER_ADDRESS, PM_ABI, wallet);
    const params = {
        tokenId,
        amount0Desired: rawA,
        amount1Desired: rawB,
        amount0Min: 0,
        amount1Min: 0,
        deadline: Math.floor(Date.now() / 1000) + 600
    };

    try {
        const tx = await pm.increaseLiquidity(params, { gasLimit: 600_000 });
        const receipt = await tx.wait();
        console.log(`  ✓ Liquidity added: ${receipt.hash.slice(0, 10)}...`);
    } catch (error) {
        console.error(`  ✗ Failed: ${error.message}`);
    }
}

// Main Logic
async function manage(tA, tB) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    const key = `${tA}-${tB}`;
    const cfg = CONFIG[key];
    if (!cfg) {
        console.log(`⚠ No config for pair ${key}`);
        return;
    }

    const [infoA, infoB] = await Promise.all([getTokenInfo(tA), getTokenInfo(tB)]);
    console.log(`📊 Managing ${infoA.symbol}/${infoB.symbol}`);

    // Show current balances
    const [balA, balB] = await Promise.all([getBalance(tA), getBalance(tB)]);
    console.log(`  Wallet: ${ethers.formatUnits(balA, infoA.decimals)} ${infoA.symbol} | ${ethers.formatUnits(balB, infoB.decimals)} ${infoB.symbol}`);

    const pd = await getPoolData(tA, tB);
    if (!pd) {
        console.log(`⚠ No pool found`);
        return;
    }

    const ratio = pd.token0.toLowerCase() === tA.toLowerCase() ? pd.price : 1 / pd.price;
    // Use closest bound as target instead of middle
    const target = ratio > cfg.max ? cfg.max : (ratio < cfg.min ? cfg.min : ratio);
    const diff = Math.abs((ratio - target) / target);

    console.log(`  Pool ratio: ${ratio.toFixed(6)} | Target: ${target.toFixed(4)} | Diff: ${(diff * 100).toFixed(2)}%`);

    // Only swap if needed
    if (ratio < cfg.min) {
        console.log(`📉 Need more ${infoA.symbol} → Swap ${infoB.symbol} → ${infoA.symbol}`);
        const bal = Number(ethers.formatUnits(balB, infoB.decimals));
        const swapAmt = (bal * (1 - RESERVE_PERCENTAGE) * 0.5).toFixed(6); // Use only 5% of balance

        if (parseFloat(swapAmt) > 0.001) {
            await swap(tB, tA, swapAmt, infoB.decimals);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    } else if (ratio > cfg.max) {
        console.log(`📈 Need more ${infoB.symbol} → Swap ${infoA.symbol} → ${infoB.symbol}`);
        const bal = Number(ethers.formatUnits(balA, infoA.decimals));
        const swapAmt = (bal * (1 - RESERVE_PERCENTAGE) * 0.5).toFixed(6); // Use only 5% of balance

        if (parseFloat(swapAmt) > 0.001) {
            await swap(tA, tB, swapAmt, infoA.decimals);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    } else {
        console.log(`✓ Ratio OK`);
    }

    // Add fixed small amounts to LP (not all balance!)
    if (!positions[key]) {
        positions[key] = await mintPosition(tA, tB, cfg.lpAmountA, cfg.lpAmountB);
    } else {
        await addFixedLiquidity(positions[key], tA, tB, cfg.lpAmountA, cfg.lpAmountB);
    }

    // Show remaining balances
    const [newBalA, newBalB] = await Promise.all([getBalance(tA), getBalance(tB)]);
    console.log(`  Remaining: ${ethers.formatUnits(newBalA, infoA.decimals)} ${infoA.symbol} | ${ethers.formatUnits(newBalB, infoB.decimals)} ${infoB.symbol}`);
}

// Run
async function main() {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`⏰ ${new Date().toLocaleTimeString()} - LP Bot Cycle`);
    console.log("=".repeat(50));

    try {
        await manage(TOKENS.USDC, TOKENS.USDT);
        await manage(TOKENS.ETH, TOKENS.USDC);
        await manage(TOKENS.ETH, TOKENS.USDT);
        console.log(`\n✅ Cycle completed`);
    } catch (e) {
        console.error(`\n❌ Error: ${e.message}`);
    }
}

main();
setInterval(main, 60_000);