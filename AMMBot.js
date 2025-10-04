// amm-lp-bot-v3.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// Uniswap SDK imports
import { Token } from "@uniswap/sdk-core";
import { Pool, Position, nearestUsableTick } from "@uniswap/v3-sdk";

// Local ABIs
const UNISWAP_V3_POOL_ABI = require("./ABI/PoolABI.json").abi;
const POSITION_MANAGER_ABI = require("./ABI/PositionManagerABI.json").abi;
const ERC20_ABI = require("./ABI/IERC20.json").abi;
const FACTORY_ABI = [
    "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"
];
const SWAP_ROUTER_ABI = [
    "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];

// === CONFIG (from .env) ===
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;
const POSITION_MANAGER_ADDRESS =
    process.env.POSITION_MANAGER_ADDRESS || process.env.POSITION_MANAGER;
const SWAP_ROUTER = process.env.SWAP_ROUTER_ADDRESS;

if (!RPC_URL || !PRIVATE_KEY || !FACTORY_ADDRESS || !POSITION_MANAGER_ADDRESS || !SWAP_ROUTER) {
    throw new Error("Set RPC_URL, PRIVATE_KEY, FACTORY_ADDRESS, POSITION_MANAGER_ADDRESS and SWAP_ROUTER_ADDRESS in .env");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
const swapRouter = new ethers.Contract(SWAP_ROUTER, SWAP_ROUTER_ABI, wallet);

// Example tokens
const TOKENS = {
    USDC: "0x2A4c1D209ef13dBB846c7E7421a0B8238D155fFB",
    USDT: "0x188D71EE19cB9976213BBa3867ED5EdAA04e6E78",
    ETH: "0xEc8f91aDD963aF50f9390795DcD2828990308FA5"
};

// Pair config
const PAIR_CONFIG = {
    [`${TOKENS.USDC}-${TOKENS.USDT}`]: { min: 0.95, max: 1.05 },
    [`${TOKENS.USDT}-${TOKENS.USDC}`]: { min: 0.95, max: 1.05 },
    [`${TOKENS.ETH}-${TOKENS.USDC}`]: { min: 9, max: 11 },
    [`${TOKENS.USDC}-${TOKENS.ETH}`]: { min: 0.09, max: 0.15 },
    [`${TOKENS.ETH}-${TOKENS.USDT}`]: { min: 9, max: 11 },
    [`${TOKENS.USDT}-${TOKENS.ETH}`]: { min: 0.09, max: 0.11 }
};

// Store minted tokenIds per pair
const tokenIds = {};

// === HELPERS ===
async function getPoolAddress(tokenA, tokenB, fee = 500) {
    return factory.getPool(tokenA, tokenB, fee);
}

async function getPoolState(poolAddr) {
    const pool = new ethers.Contract(poolAddr, UNISWAP_V3_POOL_ABI, provider);
    const [token0, token1, slot0, liquidity] = await Promise.all([
        pool.token0(),
        pool.token1(),
        pool.slot0(),
        pool.liquidity()
    ]);
    const sqrtPriceX96 = slot0[0];
    const tick = Number(slot0[1]);
    const price = (Number(sqrtPriceX96.toString()) / 2 ** 96) ** 2;
    return { token0, token1, price, tick, sqrtPriceX96, liquidity };
}

async function approveIfNeeded(tokenAddr, ownerSigner, spender, amount = ethers.MaxUint256) {
    const token = new ethers.Contract(tokenAddr, ERC20_ABI, ownerSigner);
    const allowance = await token.allowance(await ownerSigner.getAddress(), spender);
    if (BigInt(allowance.toString()) < BigInt(amount.toString())) {
        const tx = await token.approve(spender, amount);
        await tx.wait();
    }
}

async function getBalance(tokenAddr) {
    const token = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    return token.balanceOf(await wallet.getAddress());
}

// === Create Position (mint) ===
async function createPosition(tokenA, tokenB, amountA, amountB, fee = 500) {
    const poolAddr = await getPoolAddress(tokenA, tokenB, fee);
    if (poolAddr === ethers.ZeroAddress) throw new Error("No pool");

    const poolContract = new ethers.Contract(poolAddr, UNISWAP_V3_POOL_ABI, provider);
    const [tickSpacingBN, poolFeeBN, liquidityBN, slot0, token0Addr, token1Addr] =
        await Promise.all([
            poolContract.tickSpacing(),
            poolContract.fee(),
            poolContract.liquidity(),
            poolContract.slot0(),
            poolContract.token0(),
            poolContract.token1()
        ]);

    const tickSpacing = Number(tickSpacingBN);
    const poolFee = Number(poolFeeBN);
    const sqrtPriceX96 = slot0[0].toString();
    const tick = Number(slot0[1]);

    const tokenAContract = new ethers.Contract(tokenA, ERC20_ABI, provider);
    const tokenBContract = new ethers.Contract(tokenB, ERC20_ABI, provider);
    const [decA, decB, symA, symB] = await Promise.all([
        tokenAContract.decimals(),
        tokenBContract.decimals(),
        tokenAContract.symbol(),
        tokenBContract.symbol()
    ]);

    const chainId = (await provider.getNetwork()).chainId;
    const tokenObjA = new Token(Number(chainId), tokenA, Number(decA), symA);
    const tokenObjB = new Token(Number(chainId), tokenB, Number(decB), symB);

    const addr0 = token0Addr.toLowerCase();
    const token0 = addr0 === tokenA.toLowerCase() ? tokenObjA : tokenObjB;
    const token1 = addr0 === tokenA.toLowerCase() ? tokenObjB : tokenObjA;

    const pool = new Pool(token0, token1, poolFee, sqrtPriceX96, liquidityBN.toString(), tick);

    const baseTick = nearestUsableTick(tick, tickSpacing);
    const tickLower = baseTick - tickSpacing * 2;
    const tickUpper = baseTick + tickSpacing * 2;

    const amountARaw = ethers.parseUnits(amountA, Number(decA));
    const amountBRaw = ethers.parseUnits(amountB, Number(decB));

    const amounts =
        addr0 === tokenA.toLowerCase()
            ? { amount0: amountARaw, amount1: amountBRaw }
            : { amount0: amountBRaw, amount1: amountARaw };

    const position = Position.fromAmounts({
        pool,
        tickLower,
        tickUpper,
        amount0: amounts.amount0.toString(),
        amount1: amounts.amount1.toString(),
        useFullPrecision: true
    });

    const amount0Desired = position.mintAmounts.amount0.toString();
    const amount1Desired = position.mintAmounts.amount1.toString();

    await approveIfNeeded(token0.address, wallet, POSITION_MANAGER_ADDRESS);
    await approveIfNeeded(token1.address, wallet, POSITION_MANAGER_ADDRESS);

    const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, wallet);
    const mintParams = {
        token0: token0.address,
        token1: token1.address,
        fee: poolFee,
        tickLower,
        tickUpper,
        amount0Desired,
        amount1Desired,
        amount0Min: 0,
        amount1Min: 0,
        recipient: await wallet.getAddress(),
        deadline: Math.floor(Date.now() / 1000) + 600
    };

    const tx = await positionManager.mint(mintParams, { gasLimit: 1_200_000 });
    const receipt = await tx.wait();

    // extract tokenId
    let tokenId;
    for (const log of receipt.logs) {
        try {
            const parsed = positionManager.interface.parseLog(log);
            if (parsed.name === "Transfer") {
                tokenId = parsed.args.tokenId.toString();
            }
        } catch (e) { }
    }

    console.log("Minted new position. TokenId:", tokenId);
    return tokenId;
}

// === Increase Liquidity ===
async function increaseLiquidity(tokenId, tokenA, tokenB, addAmountA, addAmountB) {
    const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, wallet);

    await approveIfNeeded(tokenA, wallet, POSITION_MANAGER_ADDRESS);
    await approveIfNeeded(tokenB, wallet, POSITION_MANAGER_ADDRESS);

    const params = {
        tokenId,
        amount0Desired: addAmountA,
        amount1Desired: addAmountB,
        amount0Min: 0,
        amount1Min: 0,
        deadline: Math.floor(Date.now() / 1000) + 600
    };

    const tx = await positionManager.increaseLiquidity(params, { gasLimit: 600_000 });
    const receipt = await tx.wait();
    console.log("Increased liquidity for tokenId", tokenId, receipt.transactionHash);
}

// === Swap ===
async function rebalanceBySwap(tokenIn, tokenOut, amountIn, decimals) {
    await approveIfNeeded(tokenIn, wallet, SWAP_ROUTER);
    const params = {
        tokenIn,
        tokenOut,
        fee: 500,
        recipient: await wallet.getAddress(),
        deadline: Math.floor(Date.now() / 1000) + 600,
        amountIn: ethers.parseUnits(amountIn, decimals),
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
    };
    const tx = await swapRouter.exactInputSingle(params, { gasLimit: 500_000 });
    return tx.wait();
}

// === Manage Liquidity ===
async function calcSwapAmount(tokenIn, decimals, diffPct) {
    const bal = await getBalance(tokenIn);
    const balNum = Number(ethers.formatUnits(bal, decimals));

    // Swap at most 20% of balance or needed to correct deviation
    const swapAmt = balNum * Math.min(diffPct, 0.2);
    return swapAmt.toFixed(6); // keep precision
}

export async function manageLiquidity(tokenA, tokenB) {
    const poolAddr = await getPoolAddress(tokenA, tokenB, 500);
    if (poolAddr === ethers.ZeroAddress) return;

    const poolState = await getPoolState(poolAddr);
    let actualRatio =
        poolState.token0.toLowerCase() === tokenA.toLowerCase()
            ? 1 / poolState.price
            : poolState.price;

    const key = `${tokenA}-${tokenB}`;
    const cfg = PAIR_CONFIG[key];
    if (!cfg) return;

    const target = (cfg.min + cfg.max) / 2;
    const diffPct = Math.abs((actualRatio - target) / target);
    console.log(`Ratio ${actualRatio}, target ${target}, diff ${diffPct * 100}%`);

    // --------------------------
    // 🔹 First correct ratio (if needed)
    // --------------------------
    if (actualRatio < cfg.min) {
        console.log("📉 Ratio < min → need more A, swap B→A first");
        const tokenBContract = new ethers.Contract(tokenB, ERC20_ABI, provider);
        const decB = Number(await tokenBContract.decimals());

        const swapAmt = await calcSwapAmount(tokenB, decB, diffPct);
        console.log(`Swapping ${swapAmt} ${await tokenBContract.symbol()}`);
        await rebalanceBySwap(tokenB, tokenA, swapAmt, decB);
    } else if (actualRatio > cfg.max) {
        console.log("📈 Ratio > max → need more B, swap A→B first");
        const tokenAContract = new ethers.Contract(tokenA, ERC20_ABI, provider);
        const decA = Number(await tokenAContract.decimals());

        const swapAmt = await calcSwapAmount(tokenA, decA, diffPct);
        console.log(`Swapping ${swapAmt} ${await tokenAContract.symbol()}`);
        await rebalanceBySwap(tokenA, tokenB, swapAmt, decA);
    } else {
        console.log("👌 Ratio within bounds → no swap needed");
    }

    // --------------------------
    // 🔹 Then add liquidity
    // --------------------------
    if (!tokenIds[key]) {
        // No LP yet → mint new position
        console.log("Creating first LP position for pair", key);
        tokenIds[key] = await createPosition(tokenA, tokenB, "50", "50");
    } else {
        // Already have LP → just top up with swapped tokens
        console.log("Increasing liquidity in existing position", tokenIds[key]);
        const newBalA = await getBalance(tokenA);
        const newBalB = await getBalance(tokenB);
        await increaseLiquidity(tokenIds[key], tokenA, tokenB, newBalA, newBalB);
    }
}



// === MAIN LOOP ===
async function main() {
    await manageLiquidity(TOKENS.USDC, TOKENS.USDT);
    await manageLiquidity(TOKENS.USDC, TOKENS.ETH);
    await manageLiquidity(TOKENS.USDT, TOKENS.ETH);
}

setInterval(main, 60_000);
