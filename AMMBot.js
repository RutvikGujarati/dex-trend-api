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

const ERC20_ABI = ["function approve(address,uint256)","function allowance(address,address) view returns (uint256)","function balanceOf(address) view returns (uint256)","function decimals() view returns (uint8)"];
const EXECUTOR_ABI = require("./ABI/LimitOrder.json");
const ROUTER_ABI = ["function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)"];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POOL_ABI = ["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contracts = {
    executor: new ethers.Contract(EXECUTOR_ADDR, EXECUTOR_ABI, wallet),
    router: new ethers.Contract(ROUTER_ADDR, ROUTER_ABI, wallet),
    factory: new ethers.Contract(FACTORY_ADDR, FACTORY_ABI, wallet)
};

let isRunning = false; 

// --- HELPERS ---

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

// --- CORE FUNCTIONS ---

async function ensureDummyOrders(token, symbol, marketPrice) {
    console.log(`\n🔍 Checking Depth [${symbol}] via Events...`);

    const decT = await getDecimals(token);
    const decU = await getDecimals(TOKENS.USDT);
    const uAddr = TOKENS.USDT.toLowerCase();
    const tAddr = token.toLowerCase();

    // --- STEP 1: Find Relevant IDs via Logs ---
    const relevantIds = [];
    
    try {
        const currentBlock = await provider.getBlockNumber();
        const LOOKBACK = 50000; 
        
        // ✅ FIX: Ensure we don't calculate a negative block number
        const fromBlock = Math.max(0, currentBlock - LOOKBACK);
        
        console.log(`   Scanning Blocks: ${fromBlock} to ${currentBlock}`);

        // Ensure your ABI has the event "OrderCreated" defined correctly!
        const filter = contracts.executor.filters.OrderCreated(); 
        const logs = await contracts.executor.queryFilter(filter, fromBlock, currentBlock);

        for (const log of logs) {
            const args = log.args; 
            
            // Adjust indices based on your specific ABI event structure
            // Example assuming: event OrderCreated(uint256 id, address user, address tokenIn, address tokenOut, ...)
            const id = Number(args[0]); 
            const tIn = String(args[2]).toLowerCase();
            const tOut = String(args[3]).toLowerCase();

            // Filter for our specific pair
            if ((tIn === uAddr && tOut === tAddr) || (tIn === tAddr && tOut === uAddr)) {
                relevantIds.push(id);
            }
        }
        
        relevantIds.sort((a, b) => b - a); // Newest first
        console.log(`   Found ${relevantIds.length} orders for ${symbol} in logs`);

    } catch (e) {
        console.error("   ⚠️ Event fetch failed. Falling back to simple scan.", e.message);
        // Fallback: Scan the last 50 IDs manually if events fail
        const nextId = Number(await contracts.executor.nextOrderId());
        for(let i=1; i<=50; i++) relevantIds.push(nextId - i);
    }

    // --- STEP 2: Check Status (Same as before) ---
    let buys = 0, sells = 0;
    
    // Check mostly the latest ones we found
    const idsToCheck = relevantIds.slice(0, 20); 

    const promises = idsToCheck.map(id => {
        if(id < 0) return null;
        return contracts.executor.getOrder(id).catch(() => null)
    });
    
    const orders = await Promise.all(promises);

    for (const o of orders) {
        if (!o || o.filled || o.cancelled || o.amountIn === 0n) continue;

        const tIn = o.tokenIn.toLowerCase();
        const tOut = o.tokenOut.toLowerCase();

        if (tIn === uAddr && tOut === tAddr) buys++;
        if (tIn === tAddr && tOut === uAddr) sells++;
    }

    console.log(`📊 Depth: ${buys} Buys | ${sells} Sells`);

    // --- STEP 3: Create Orders (Same Logic) ---
    const amtT = ethers.parseUnits(DUMMY_AMOUNT.toString(), decT);
    const amtU = ethers.parseUnits((DUMMY_AMOUNT * marketPrice).toFixed(6), decU);

    if (buys < 5) {
        const needed = 5 - buys;
        console.log(`➕ Creating ${needed} BUYs...`);
        const bal = await getBalance(TOKENS.USDT);
        if (bal >= amtU * BigInt(needed)) {
            await approve(TOKENS.USDT, EXECUTOR_ADDR, amtU * 10n);
            const stairs = [0.98, 0.95, 0.92, 0.90, 0.88];
            for (let i = 0; i < needed; i++) {
                const p = stairs[i % stairs.length];
                const price = ethers.parseUnits((marketPrice * p).toFixed(4), 18);
                await sendTx(
                    contracts.executor.depositAndCreateOrder(TOKENS.USDT, token, amtU, amtT, price, 86400 * 3, 0, await getOpts(400000)),
                    `Dummy Buy ${symbol} @ $${(marketPrice * p).toFixed(2)}`
                );
            }
        }
    }

    if (sells < 5) {
        const needed = 5 - sells;
        console.log(`➕ Creating ${needed} SELLs...`);
        const bal = await getBalance(token);
        if (bal >= amtT * BigInt(needed)) {
            await approve(token, EXECUTOR_ADDR, amtT * 10n);
            const stairs = [1.02, 1.05, 1.08, 1.10, 1.12];
            for (let i = 0; i < needed; i++) {
                const p = stairs[i % stairs.length];
                const price = ethers.parseUnits((marketPrice * p).toFixed(4), 18);
                await sendTx(
                    contracts.executor.depositAndCreateOrder(token, TOKENS.USDT, amtT, amtU, price, 86400 * 3, 1, await getOpts(400000)),
                    `Dummy Sell ${symbol} @ $${(marketPrice * p).toFixed(2)}`
                );
            }
        }
    }
}

async function alignUniswapPool(token, symbol, marketPrice) {
    if (token.toLowerCase() === TOKENS.USDT.toLowerCase()) return;
    try {
        const poolAddr = await contracts.factory.getPool(token, TOKENS.USDT, FEE);
        if (poolAddr === ethers.ZeroAddress) return console.log(`⚠️ No V3 Pool for ${symbol}`);

        const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
        const [sqrtPriceX96] = await pool.slot0();
        
        const decT = await getDecimals(token);
        const decU = await getDecimals(TOKENS.USDT);
        const isToken0 = token.toLowerCase() < TOKENS.USDT.toLowerCase();

        // Calculate current Pool Price
        const priceRatio = (Number(sqrtPriceX96) ** 2) / (2 ** 192);
        const v3Price = isToken0 
            ? priceRatio * (10 ** (decU - decT)) 
            : (1 / priceRatio) * (10 ** (decT - decU));

        const diff = Math.abs(v3Price - marketPrice) / marketPrice;
        console.log(`🦄 V3: $${v3Price.toFixed(4)} (Mkt: $${marketPrice}) | Diff: ${(diff*100).toFixed(2)}%`);
        
        // ALIGNMENT LOGIC
        if (diff > 0.005) { // 0.5% deviation threshold
            console.log(`⚡ V3 Deviation > 0.5%. Executing FULL Alignment...`);
            const isV3Cheap = v3Price < marketPrice; // If V3 is cheap, we BUY token
            
            // 1. Calculate the Target SqrtPrice (The "Brake" Price)
            const targetRatio = isToken0 
                ? marketPrice / (10 ** (decU - decT)) 
                : (1 / marketPrice) / (10 ** (decT - decU));
            
            // Limit = sqrt(ratio) * 2^96
            const targetSqrt = BigInt(Math.floor(Math.sqrt(targetRatio) * (2 ** 96)));
            
            // 2. Setup Swap Direction
            const tokenIn = isV3Cheap ? TOKENS.USDT : token;
            const tokenOut = isV3Cheap ? token : TOKENS.USDT;
            
            // 3. Use FULL Balance as potential input (Contract refunds unused)
            // This ensures we have enough "fuel" to push the price all the way
            const balance = await getBalance(tokenIn);
            if(balance === 0n) return console.warn(`⚠️ Zero balance of ${isV3Cheap ? 'USDT' : symbol} - Cannot align.`);

            await approve(tokenIn, ROUTER_ADDR, balance);
            
            await sendTx((async() => {
                return contracts.router.exactInputSingle({
                    tokenIn, tokenOut, fee: FEE, recipient: wallet.address,
                    deadline: Math.floor(Date.now()/1000)+300, 
                    amountIn: balance, // Use ALL available tokens
                    amountOutMinimum: 0, 
                    sqrtPriceLimitX96: targetSqrt // STOP exactly at target price
                }, await getOpts(1500000));
            })(), `Full Align V3 ${symbol}`);
        }
    } catch (e) { console.error(`❌ V3 Align Error [${symbol}]:`, e.message); }
}

async function updateLimitPrice(token, symbol, marketPrice) {
    const decT = await getDecimals(token);
    const decU = await getDecimals(TOKENS.USDT);
    const amountT = ethers.parseUnits("1", decT);
    const amountU = ethers.parseUnits(marketPrice.toFixed(6), decU);

    // Limit Buy Update
    const balU = await getBalance(TOKENS.USDT);
    if(balU >= amountU) {
        await approve(TOKENS.USDT, EXECUTOR_ADDR, amountU);
        await sendTx((async()=> contracts.executor.depositAndCreateOrder(TOKENS.USDT, token, amountU, amountT, ethers.parseUnits(marketPrice.toFixed(4), 18), 86400, 0, await getOpts(500000)))(), `Limit Buy ${symbol}`);
    } else { console.warn(`⚠️ Insufficient USDT for limit buy`); }

    // Limit Sell Update
    const balT = await getBalance(token);
    if(balT >= amountT) {
        await approve(token, EXECUTOR_ADDR, amountT);
        await sendTx((async()=> contracts.executor.depositAndCreateOrder(token, TOKENS.USDT, amountT, amountU, ethers.parseUnits(marketPrice.toFixed(4), 18), 86400, 1, await getOpts(500000)))(), `Limit Sell ${symbol}`);
    } else { console.warn(`⚠️ Insufficient ${symbol} for limit sell`); }
}

async function main() {
    if (isRunning) return console.log("⚠️ Skip: Busy.");
    isRunning = true;
    console.log(`\n=== Cycle Start: ${new Date().toLocaleTimeString()} ===`);

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
            await alignUniswapPool(addr, symbol, price);
        }
    } catch (e) { console.error("❌ Cycle Error:", e.message); }
    
    isRunning = false;
    console.log(`\n✅ Done.`);
}

console.log("🟢 SuperBot Started");
main();
setInterval(main, 300);