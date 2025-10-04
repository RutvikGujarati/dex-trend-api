// amm-lp-bot-v3.js
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// Uniswap SDK imports
import { Token } from "@uniswap/sdk-core";
import { Pool, Position, nearestUsableTick } from "@uniswap/v3-sdk";

// Local ABIs - make sure these files exist
const UNISWAP_V3_POOL_ABI = require("./ABI/PoolABI.json");
const POSITION_MANAGER_ABI = require("./ABI/PositionManagerABI.json"); // NonfungiblePositionManager full ABI or minimal that includes mint, positions, decreaseLiquidity, collect
const ERC20_ABI = require("./ABI/IERC20.json");
const FACTORY_ABI = [
    "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"
];

// === CONFIG (from .env) ===
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;
const POSITION_MANAGER_ADDRESS = process.env.POSITION_MANAGER_ADDRESS || process.env.POSITION_MANAGER; // either var

if (!RPC_URL || !PRIVATE_KEY || !FACTORY_ADDRESS || !POSITION_MANAGER_ADDRESS) {
    throw new Error("Set RPC_URL, PRIVATE_KEY, FACTORY_ADDRESS and POSITION_MANAGER_ADDRESS in .env");
}

// provider & wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider); // this is the signer

const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);

// Example tokens (replace with your contract addresses)
const TOKENS = {
    USDC: "0x2A4c1D209ef13dBB846c7E7421a0B8238D155fFB",
    USDT: "0x188D71EE19cB9976213BBa3867ED5EdAA04e6E78",
    ETH: "0xEc8f91aDD963aF50f9390795DcD2828990308FA5",
};

// Pair config (min/max interpreted as price tokenA/tokenB)
const PAIR_CONFIG = {
    // USDC/USDT ~1:1
    [`${TOKENS.USDC}-${TOKENS.USDT}`]: { min: 0.95, max: 1.05 },
    [`${TOKENS.USDT}-${TOKENS.USDC}`]: { min: 0.95, max: 1.05 },

    // ETH:USDC and ETH:USDT according to your test ratio
    // note: choose the ordering and values that match tokenA/tokenB in the key
    [`${TOKENS.ETH}-${TOKENS.USDC}`]: { min: 9, max: 11 },     // tokenA/tokenB = ETH/USDC ~ 1:10 -> price ~ 10 so inverse keys may change meaning
    [`${TOKENS.USDC}-${TOKENS.ETH}`]: { min: 0.09, max: 0.15 },

    [`${TOKENS.ETH}-${TOKENS.USDT}`]: { min: 9, max: 11 },
    [`${TOKENS.USDT}-${TOKENS.ETH}`]: { min: 0.09, max: 0.11 },
};

// === HELPERS ===

async function getPoolAddress(tokenA, tokenB, fee = 500) {
    // factory.getPool(tokenA, tokenB, fee)
    const pool = await factory.getPool(tokenA, tokenB, fee);
    console.log(`getPool: ${tokenA.slice(0, 6)} / ${tokenB.slice(0, 6)} -> ${pool}`);
    return pool;
}

async function getPoolState(poolAddr) {
    const pool = new ethers.Contract(poolAddr, UNISWAP_V3_POOL_ABI.abi, provider);
    const [token0, token1, slot0, liquidity] = await Promise.all([
        pool.token0(),
        pool.token1(),
        pool.slot0(), // returns [sqrtPriceX96, tick, observationIndex, observationCardinality, observationCardinalityNext, feeProtocol, unlocked]
        pool.liquidity()
    ]);

    const sqrtPriceX96 = slot0[0];
    const tick = Number(slot0[1]);

    const sqrtAsNum = Number(sqrtPriceX96.toString());
    const price = (sqrtAsNum / 2 ** 96) ** 2;

    console.log(`PoolState: token0=${token0.slice(0, 6)} token1=${token1.slice(0, 6)} price=${price} tick=${tick} liquidity=${liquidity}`);
    return { token0, token1, price, tick, sqrtPriceX96, liquidity };
}

async function approveIfNeeded(tokenAddr, ownerSigner, spender, amount = ethers.MaxUint256) {
    const token = new ethers.Contract(tokenAddr, ERC20_ABI.abi, ownerSigner);
    const allowance = await token.allowance(await ownerSigner.getAddress(), spender);
    if (BigInt(allowance.toString()) < BigInt(amount.toString())) {
        console.log(`Approving ${tokenAddr.slice(0, 6)} for ${spender}...`);
        const tx = await token.connect(ownerSigner).approve(spender, amount);
        await tx.wait();
        console.log("Approved.");
    } else {
        console.log(`Already approved ${tokenAddr.slice(0, 6)}.`);
    }
}

// === ADD Liquidity (V3 mint) ===
// params: tokenA, tokenB addresses (string), amountA/amountB strings in human format (e.g., "100"), fee (500)
export async function addLiquidityV3({ tokenA, tokenB, amountA, amountB, fee = 500 }) {
    console.log(`AddLiquidityV3: ${tokenA.slice(0, 6)} / ${tokenB.slice(0, 6)} amountA=${amountA} amountB=${amountB} fee=${fee}`);

    // Sort tokens for pool lookup
    const [t0, t1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
    const poolAddr = await getPoolAddress(t0, t1, fee);
    if (poolAddr === ethers.ZeroAddress) throw new Error("Pool does not exist");

    // read pool state
    const poolContract = new ethers.Contract(poolAddr, UNISWAP_V3_POOL_ABI, provider);
    const [tickSpacingBN, poolFeeBN, liquidityBN, slot0, token0Addr, token1Addr] = await Promise.all([
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

    // fetch decimals & symbols
    const tokenAContract = new ethers.Contract(tokenA, ERC20_ABI, provider);
    const tokenBContract = new ethers.Contract(tokenB, ERC20_ABI, provider);
    const [decA, decB, symA, symB] = await Promise.all([
        tokenAContract.decimals(),
        tokenBContract.decimals(),
        tokenAContract.symbol(),
        tokenBContract.symbol()
    ]);

    const chainId = (await provider.getNetwork()).chainId;
    const tokenObjA = new Token(Number(chainId), tokenA, Number(decA), symA, symA);
    const tokenObjB = new Token(Number(chainId), tokenB, Number(decB), symB, symB);

    // build Pool
    const addr0 = token0Addr.toLowerCase();
    const token0 = addr0 === tokenA.toLowerCase() ? tokenObjA : tokenObjB;
    const token1 = addr0 === tokenA.toLowerCase() ? tokenObjB : tokenObjA;

    const pool = new Pool(token0, token1, poolFee, sqrtPriceX96, liquidityBN.toString(), tick);

    // determine tick range
    const baseTick = nearestUsableTick(tick, tickSpacing);
    const tickLower = baseTick - tickSpacing * 2;
    const tickUpper = baseTick + tickSpacing * 2;

    // parse amounts to raw
    const amountARaw = ethers.parseUnits(amountA, decA); // BigInt
    const amountBRaw = ethers.parseUnits(amountB, decB);

    // arrange according to token0/token1 ordering
    const amounts = addr0 === tokenA.toLowerCase()
        ? { amount0: amountARaw.toString(), amount1: amountBRaw.toString() }
        : { amount0: amountBRaw.toString(), amount1: amountARaw.toString() };

    // build position
    const position = Position.fromAmounts({
        pool,
        tickLower,
        tickUpper,
        amount0: amounts.amount0,
        amount1: amounts.amount1,
        useFullPrecision: true
    });

    const amount0Desired = position.mintAmounts.amount0.toString();
    const amount1Desired = position.mintAmounts.amount1.toString();

    // approvals using wallet signer
    await approveIfNeeded(token0.address, wallet, POSITION_MANAGER_ADDRESS);
    await approveIfNeeded(token1.address, wallet, POSITION_MANAGER_ADDRESS);

    // mint on Position Manager
    const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI, wallet);

    const mintParams = {
        token0: token0.address,
        token1: token1.address,
        fee: poolFee,
        tickLower,
        tickUpper,
        amount0Desired,
        amount1Desired,
        amount0Min: "0",
        amount1Min: "0",
        recipient: await wallet.getAddress(),
        deadline: Math.floor(Date.now() / 1000) + 600
    };

    console.log("Mint params:", { token0: token0.address, token1: token1.address, tickLower, tickUpper, amount0Desired, amount1Desired });

    const tx = await positionManager.mint(mintParams, { gasLimit: 1_200_000 });
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error(`Mint failed: ${receipt.transactionHash}`);
    console.log("Mint success tx:", receipt.transactionHash);
    return receipt.transactionHash;
}

// === Remove Liquidity (V3) ===
// This function expects you to pass a specific tokenId (LP NFT id) and percentage of liquidity to remove (0-100)
export async function removeLiquidityV3({ tokenId, percentage = 100 }) {
    if (!tokenId) throw new Error("tokenId required to remove liquidity");
    if (percentage <= 0 || percentage > 100) throw new Error("percentage must be 1..100");
    console.log(`removeLiquidityV3: tokenId=${tokenId} pct=${percentage}`);

    const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI.abi, wallet);

    // fetch position data
    const pos = await positionManager.positions(tokenId);
    // pos tuple: see your minimal ABI order; we assume index 7 is liquidity (uint128)
    const liquidity = BigInt(pos[7].toString());
    if (liquidity === 0n) {
        console.log("No liquidity in position");
        return;
    }

    const liquidityToRemove = (liquidity * BigInt(percentage)) / 100n;

    // decrease liquidity
    const decreaseParams = {
        tokenId: Number(tokenId),
        liquidity: liquidityToRemove,
        amount0Min: 0,
        amount1Min: 0,
        deadline: Math.floor(Date.now() / 1000) + 600
    };

    console.log("decreaseLiquidity params:", decreaseParams);
    const tx1 = await positionManager.decreaseLiquidity(decreaseParams, { gasLimit: 600_000 });
    await tx1.wait();
    console.log("decreaseLiquidity tx done");

    // collect all tokens
    const MAX_UINT128 = (2n ** 128n - 1n).toString();
    const collectParams = { tokenId: Number(tokenId), recipient: await wallet.getAddress(), amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 };
    const tx2 = await positionManager.collect(collectParams, { gasLimit: 600_000 });
    await tx2.wait();
    console.log("collect tx done - liquidity removed and tokens collected");
}
async function getUserPositionsForPair({ walletAddr, tokenA, tokenB, fee = 500 }) {
    const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI.abi, provider);

    const balance = await positionManager.balanceOf(walletAddr);
    const numPositions = Number(balance);

    if (numPositions === 0) {
        console.log(`⚠️ No LP positions for ${walletAddr}`);
        return [];
    }

    console.log(`🔍 Found ${numPositions} positions for wallet ${walletAddr}`);

    const positions = [];

    for (let i = 0; i < numPositions; i++) {
        const tokenId = await positionManager.tokenOfOwnerByIndex(walletAddr, i);
        const pos = await positionManager.positions(tokenId);

        // pos returns a struct. According to Uniswap V3 docs:
        // struct Position { nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, ... }
        const token0 = pos[2];
        const token1 = pos[3];
        const posFee = Number(pos[4]);

        const liquidity = BigInt(pos[7].toString());

        // check if matches our pair (order-insensitive) + fee
        const isMatch =
            ((token0.toLowerCase() === tokenA.toLowerCase() && token1.toLowerCase() === tokenB.toLowerCase()) ||
                (token0.toLowerCase() === tokenB.toLowerCase() && token1.toLowerCase() === tokenA.toLowerCase())) &&
            posFee === fee;

        if (isMatch) {
            positions.push({
                tokenId: Number(tokenId),
                token0,
                token1,
                fee: posFee,
                liquidity
            });
        }
    }

    console.log(`✅ Matching positions for pair ${tokenA.slice(0, 6)} / ${tokenB.slice(0, 6)}:`, positions);
    return positions;
}

export async function manageLiquidity(tokenA, tokenB) {
    console.log(`\n=== Managing Liquidity for ${tokenA.slice(0, 6)} / ${tokenB.slice(0, 6)} ===`);

    // get pool address
    const poolAddr = await getPoolAddress(tokenA, tokenB, 500);
    if (poolAddr === ethers.ZeroAddress) {
        console.log("No pool found.");
        return;
    }
    console.log(`Pool Address: ${poolAddr}`);

    // fetch state
    const poolState = await getPoolState(poolAddr);

    // compute ratio tokenA/tokenB
    let actualRatio;
    if (poolState.token0.toLowerCase() === tokenA.toLowerCase()) {
        // pool.price = token1 per token0 → tokenA/tokenB = 1/price
        actualRatio = 1 / poolState.price;
    } else {
        // pool.price = token1 per token0, but token0 == tokenB → tokenA/tokenB = price
        actualRatio = poolState.price;
    }

    const key = `${tokenA}-${tokenB}`;
    const cfg = PAIR_CONFIG[key];
    if (!cfg) {
        console.log("⚠️ No config for pair", key);
        return;
    }

    console.log(`Computed ratio tokenA/tokenB = ${actualRatio} (min=${cfg.min}, max=${cfg.max})`);

    // === ACTIONS ===
    if (actualRatio < cfg.min) {
        console.log("📉 Ratio below min -> Adding liquidity...");
        try {
            const txHash = await addLiquidityV3({
                tokenA,
                tokenB,
                amountA: "100", // you can replace with balance logic
                amountB: "100",
                fee: 500
            });
            console.log(`✅ Added liquidity. Tx: ${txHash}`);
        } catch (err) {
            console.error("❌ Error adding liquidity:", err);
        }
    } else if (actualRatio > cfg.max) {
        console.log("📈 Ratio above max -> Removing liquidity...");

        try {
            const walletAddr = await wallet.getAddress();
            const positions = await getUserPositionsForPair({ walletAddr, tokenA, tokenB, fee: 500 });

            if (positions.length === 0) {
                console.log("⚠️ No positions found to remove liquidity from");
                return;
            }

            // for simplicity: take the first position
            const tokenId = positions[0].tokenId;
            await removeLiquidityV3({ tokenId, percentage: 50 });
            console.log(`✅ Removed 50% liquidity for tokenId=${tokenId}`);
        } catch (err) {
            console.error("❌ Error removing liquidity:", err);
        }
    }
    else {
        console.log("👌 Ratio within bounds. No action taken.");
    }
}


// === MAIN ===
async function main() {
    console.log("Starting LP bot (V3)...");
    try {
        await manageLiquidity(TOKENS.USDC, TOKENS.USDT);
        await manageLiquidity(TOKENS.USDC, TOKENS.ETH);
        await manageLiquidity(TOKENS.USDT, TOKENS.ETH);
    } catch (err) {
        console.error("Error in main:", err);
    }
}

setInterval(main, 60_000);

