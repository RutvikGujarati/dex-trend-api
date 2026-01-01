import { ethers } from "ethers";
import dotenv from "dotenv";
import axios from "axios";
import { createRequire } from "module";
import { TOKENS, COINGECKO_IDS } from "./constants.js";

dotenv.config();
const require = createRequire(import.meta.url);

const { RPC_URL, PRIVATE_KEY } = process.env;
const EXECUTOR_ADDR = "0x59AEeACD225bD2b2B178B2cDa53D6c6759bB2966";
const ROUTER_ADDR = "0x81Ba02Ca510a58560D183F0F5eE42E47D1846245";
const FACTORY_ADDR = "0x339A0Da8ffC7a6fc98Bf2FC53a17dEEf36F0D9c3";
const FEE = 500;
const DUMMY_AMOUNT = 0.0001;

const ERC20_ABI = [
    "function approve(address,uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)"
];

const LIMIT_ORDER_ABI = [
    ...require("./ABI/LimitOrder.json"),
    "function getLastExecutedPrice(address tokenA, address tokenB) view returns (uint256 price1e18, uint256 blockNum, uint256 buyOrderId, uint256 sellOrderId)"
];

const ROUTER_ABI = ["function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)"];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POOL_ABI = [
    "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
    "function liquidity() view returns (uint128)"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contracts = {
    executor: new ethers.Contract(EXECUTOR_ADDR, LIMIT_ORDER_ABI, wallet),
    router: new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, wallet),
    factory: new ethers.Contract(FACTORY_ADDR, FACTORY_ABI, wallet)
};

let isRunning = false;

async function sendTx(txPromise, desc = "Tx", gasLimit = 500000) {
    try {
        console.log(`⏳ Sending: ${desc}...`);
        const tx = await txPromise;
        const response = await tx.wait();
        console.log(`✅ Confirmed: ${desc} (Hash: ${response.hash.slice(0, 10)}...)`);
        return response;
    } catch (e) {
        console.error(`❌ Failed [${desc}]:`, e.shortMessage || e.message);
        return null;
    }
}

async function getOpts(gasLimit = 800000) {
    const fee = await provider.getFeeData();
    return { gasLimit, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas };
}

async function getDecimals(addr) {
    try { return Number(await new ethers.Contract(addr, ERC20_ABI, provider).decimals()); }
    catch { return 18; }
}

async function approve(token, spender, amount) {
    const c = new ethers.Contract(token, ERC20_ABI, wallet);
    if ((await c.allowance(wallet.address, spender)) < amount) {
        console.log(`🔓 Approving ${token}...`);
        await sendTx(c.approve(spender, ethers.MaxUint256, await getOpts(100000)), `Approve ${token}`);
    }
}

async function getBalance(token) {
    const c = new ethers.Contract(token, ERC20_ABI, provider);
    return await c.balanceOf(wallet.address);
}

async function scanFullDepth(token) {
    const nextId = Number(await contracts.executor.nextOrderId());
    const BATCH_SIZE = 50;

    let buys = 0;
    let sells = 0;

    const uAddr = TOKENS.USDT.toLowerCase();
    const tAddr = token.toLowerCase();

    for (let i = nextId - 1; i >= 1; i -= BATCH_SIZE) {
        const batch = [];
        for (let j = 0; j < BATCH_SIZE; j++) {
            const id = i - j;
            if (id < 1) break;
            batch.push(contracts.executor.getOrder(id).catch(() => null));
        }

        const results = await Promise.all(batch);

        for (const o of results) {
            const amountIn = o ? (o.amountIn || o[5]) : 0n;
            if (!o || o.filled || o.cancelled || amountIn === 0n) continue;

            const rawIn = o.tokenIn || o[2];
            const rawOut = o.tokenOut || o[3];
            if (!rawIn || !rawOut) continue;

            const tIn = rawIn.toLowerCase();
            const tOut = rawOut.toLowerCase();

            if (tIn === uAddr && tOut === tAddr) buys++;
            if (tIn === tAddr && tOut === uAddr) sells++;
        }
    }

    return { buys, sells };
}

async function ensureDummyOrders(token, symbol, marketPrice) {
    console.log(`\n🔍 Full Depth Scan [${symbol}]...`);
    const { buys, sells } = await scanFullDepth(token);
    console.log(`   📊 Active Orders: ${buys} Buys | ${sells} Sells`);

    const decT = await getDecimals(token);
    const decU = await getDecimals(TOKENS.USDT);
    const amtT_Dummy = ethers.parseUnits(DUMMY_AMOUNT.toString(), decT);
    const amtU_Dummy = ethers.parseUnits((DUMMY_AMOUNT * marketPrice).toFixed(6), decU);

    if (buys < 5) {
        const needed = 5 - buys;
        console.log(`   ➕ Adding ${needed} Dummy Buys...`);
        const bal = await getBalance(TOKENS.USDT);
        if (bal >= amtU_Dummy * BigInt(needed)) {
            await approve(TOKENS.USDT, EXECUTOR_ADDR, amtU_Dummy * BigInt(needed));
            const stairs = [0.98, 0.95, 0.92, 0.90, 0.88];
            for (let i = 0; i < needed; i++) {
                const p = stairs[i % stairs.length];
                const price = ethers.parseUnits((marketPrice * p).toFixed(4), 18);
                await sendTx(contracts.executor.depositAndCreateOrder(TOKENS.USDT, token, amtU_Dummy, amtT_Dummy, price, 86400 * 3, 0, await getOpts(400000)), `Dummy Buy`);
            }
        }
    }

    if (sells < 5) {
        const needed = 5 - sells;
        console.log(`   ➕ Adding ${needed} Dummy Sells...`);
        const bal = await getBalance(token);
        if (bal >= amtT_Dummy * BigInt(needed)) {
            await approve(token, EXECUTOR_ADDR, amtT_Dummy * BigInt(needed));
            const stairs = [1.02, 1.05, 1.08, 1.10, 1.12];
            for (let i = 0; i < needed; i++) {
                const p = stairs[i % stairs.length];
                const price = ethers.parseUnits((marketPrice * p).toFixed(4), 18);
                await sendTx(contracts.executor.depositAndCreateOrder(token, TOKENS.USDT, amtT_Dummy, amtU_Dummy, price, 86400 * 3, 1, await getOpts(400000)), `Dummy Sell`);
            }
        }
    }
}
async function updateLimitPrice(token, symbol, marketPrice) {
    try {
        const result = await contracts.executor.getLastExecutedPrice(token, TOKENS.USDT);
        const price1e18 = result[0];
        const contractPrice = Number(ethers.formatUnits(price1e18, 18));
        const diff = contractPrice === 0 ? 1 : Math.abs(contractPrice - marketPrice) / marketPrice;

        // If price < $0.10, allow 3% diff (0.03). Else allow 0.5% (0.005)
        const THRESHOLD = marketPrice < 0.7 ? 0.03 : 0.005;

        console.log(`   ⚖️ Contract: $${contractPrice.toFixed(4)} | Market: $${marketPrice} | Diff: ${(diff * 100).toFixed(2)}% (Limit: ${(THRESHOLD * 100)}%)`);

        if (diff < THRESHOLD) {
            console.log(`   ✅ Price Aligned.`);
            return;
        }

        console.log(`   ⚠️ Price Misaligned. Sending Limits...`);
        const decT = await getDecimals(token);
        const decU = await getDecimals(TOKENS.USDT);

        const amountT = ethers.parseUnits(DUMMY_AMOUNT.toString(), decT);

        const amountU = ethers.parseUnits((DUMMY_AMOUNT * marketPrice).toFixed(6), decU);

        const balU = await getBalance(TOKENS.USDT);
        if (balU >= amountU) {
            await approve(TOKENS.USDT, EXECUTOR_ADDR, amountU);
            await sendTx(
                contracts.executor.depositAndCreateOrder(TOKENS.USDT, token, amountU, amountT, ethers.parseUnits(marketPrice.toFixed(4), 18), 86400, 0, await getOpts(500000)),
                `Limit Buy ${symbol}`
            );
        }

        const balT = await getBalance(token);
        if (balT >= amountT) {
            await approve(token, EXECUTOR_ADDR, amountT);
            await sendTx(
                contracts.executor.depositAndCreateOrder(token, TOKENS.USDT, amountT, amountU, ethers.parseUnits(marketPrice.toFixed(4), 18), 86400, 1, await getOpts(500000)),
                `Limit Sell ${symbol}`
            );
        }
    } catch (e) {
        console.error(`   ❌ Failed to check contract price:`, e.message);
    }
}

async function main() {
    if (isRunning) return;
    isRunning = true;
    console.log(`\n=== Cycle: ${new Date().toLocaleTimeString()} ===`);

    try {
        const ids = Object.values(COINGECKO_IDS).join(",");
        const { data } = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);

        for (const [symbol, addr] of Object.entries(TOKENS)) {
            if (symbol === "USDT") continue;
            const price = data[COINGECKO_IDS[symbol]]?.usd;
            if (!price) continue;

            console.log(`\n🔹 ${symbol} @ $${price}`);
            await ensureDummyOrders(addr, symbol, price);
            await updateLimitPrice(addr, symbol, price);
        }
    } catch (e) { console.error("Cycle Error:", e.message); }

    isRunning = false;
}

console.log("🟢 Bot Started");
main();
setInterval(main, 300000);