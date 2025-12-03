// priceUpdater.js
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

const FIXED_TRADE_AMOUNTS = { BTC: 0.001, ETH: 0.001, BNB: 0.001 };
const DUMMY_ORDER_AMOUNT = 0.0001;

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
  if (token !== TOKENS.USDT) {
    const shortage = requiredAmount - bal;
    const usdtNeeded = shortage * 110n / 100n;
    return await swapFor(token, usdtNeeded);
  }
  return false;
}

async function createOrder({ tokenIn, tokenOut, amountIn, amountOutMin, price, orderType }) {
  const hasBalance = await ensureBalance(tokenIn, amountIn);
  if (!hasBalance) return null;
  await approveIfNeeded(tokenIn, EXECUTOR_ADDRESS, amountIn);
  const nextId = Number(await executor.nextOrderId());
  try {
    const tx = await executor.depositAndCreateOrder(
      tokenIn, tokenOut, amountIn, amountOutMin,
      encodePrice(price), 3 * 86400, orderType,
      { gasLimit: 700000 }
    );
    await tx.wait();
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
      if (price && isFinite(price)) out[sym] = Number(price);
    }
    return out;
  } catch {
    return null;
  }
}

async function fetchOpenOrders() {
  const nextIdBN = await executor.nextOrderId();
  const nextId = Number(nextIdBN ?? 0);
  const now = Math.floor(Date.now() / 1000);

  const tasks = [];
  for (let id = 1; id < nextId; id++) {
    tasks.push(
      executor.getOrder(id)
        .then(o => ({ id, o }))
        .catch(() => null)
    );
  }

  const results = (await Promise.all(tasks)).filter(Boolean);
  const open = [];

  for (const { id, o } of results) {
    if (!o) continue;
    const maker = o.maker || ethers.ZeroAddress;
    if (!maker || maker === ethers.ZeroAddress) continue;

    try {
      const amountIn = BigInt(o.amountIn?.toString() ?? "0");
      const expiry = Number(o.expiry?.toString() ?? 0);
      const orderType = Number(o.orderType ?? 0);
      const filled = Boolean(o.filled);
      const cancelled = Boolean(o.cancelled);

      if (!filled && !cancelled && expiry > now && amountIn > 0n) {
        open.push({
          id,
          tokenIn: (o.tokenIn || ethers.ZeroAddress).toLowerCase(),
          tokenOut: (o.tokenOut || ethers.ZeroAddress).toLowerCase(),
          orderType
        });
      }
    } catch {}
  }
  return open;
}

async function createDummyOrder(token, price, isBuy, currentPrice) {
  let adjustedPrice = price;
  if (isBuy && price >= currentPrice) {
    adjustedPrice = currentPrice * 0.95;
  } else if (!isBuy && price <= currentPrice) {
    adjustedPrice = currentPrice * 1.05;
  }

  const tokenIn = isBuy ? TOKENS.USDT : token;
  const tokenOut = isBuy ? token : TOKENS.USDT;
  const decimals = await getDecimals(tokenIn);
  const amountIn = ethers.parseUnits(DUMMY_ORDER_AMOUNT.toString(), decimals);

  try {
    const tx = await executor.depositAndCreateOrder(
      tokenIn, tokenOut, amountIn, amountIn,
      encodePrice(adjustedPrice), 3 * 86400, isBuy ? 0 : 1,
      { gasLimit: 900_000 }
    );
    await tx.wait();
    return Number(await executor.nextOrderId()) - 1;
  } catch (e) {
    console.log("❌ Dummy order failed:", e.message);
    return null;
  }
}

async function ensureDummyOrders() {
  console.log("\n🔧 Creating liquidity orders...");
  const open = await fetchOpenOrders();
  const tokens = Object.entries(TOKENS).filter(([k]) => k !== "USDT");

  for (const [sym, token] of tokens) {
    const currentPrice = await getOnchainPrice(token, TOKENS.USDT) || 1;
    console.log(`💰 ${sym}/USDT price: ${currentPrice.toFixed(6)}`);

    const tokenLower = token.toLowerCase();
    const usdtLower = TOKENS.USDT.toLowerCase();

    const buys = open.filter(o => 
      o.tokenIn === usdtLower && 
      o.tokenOut === tokenLower && 
      o.orderType === 0
    );

    const sells = open.filter(o => 
      o.tokenIn === tokenLower && 
      o.tokenOut === usdtLower && 
      o.orderType === 1
    );

    console.log(`📊 ${sym}/USDT: ${buys.length} buys, ${sells.length} sells`);

    if (buys.length < 5) {
      const needBuys = 5 - buys.length;
      console.log(`📌 Creating ${needBuys} buy orders`);
      const buyPrices = [0.98, 0.95, 0.90, 0.85, 0.80].map(m => currentPrice * m);
      for (let i = 0; i < needBuys; i++) {
        await createDummyOrder(token, buyPrices[i], true, currentPrice);
      }
    }

    if (sells.length < 5) {
      const needSells = 5 - sells.length;
      console.log(`📌 Creating ${needSells} sell orders`);
      const sellPrices = [1.02, 1.05, 1.10, 1.15, 1.20].map(m => currentPrice * m);
      for (let i = 0; i < needSells; i++) {
        await createDummyOrder(token, sellPrices[i], false, currentPrice);
      }
    }

    if (buys.length >= 5 && sells.length >= 5) {
      console.log(`✅ ${sym}/USDT sufficient liquidity`);
    }
  }
}

async function setPriceFromLive(symbol, tokenA, market) {
  const USDT = TOKENS.USDT;
  const livePrice = symbol === "USDE" ? 1 : market[symbol];

  if (!livePrice) {
    console.log(`❌ No price for ${symbol}`);
    return;
  }

  const obPrice = await getOnchainPrice(tokenA, USDT) || livePrice;
  const diff = Math.abs(livePrice - obPrice) / obPrice;

  console.log(`\n=== ${symbol} ===`);
  console.log(`Live: ${livePrice} | Onchain: ${obPrice} | Diff: ${(diff * 100).toFixed(2)}%`);

  if (diff < 0.01) {
    console.log("❌ Diff < 1% → Skip");
    return;
  }

  console.log("✅ Updating price");

  const TRADE_AMOUNT = FIXED_TRADE_AMOUNTS[symbol] || 1;
  const decA = await getDecimals(tokenA);
  const decU = await getDecimals(USDT);

  const amountToken = ethers.parseUnits(TRADE_AMOUNT.toString(), decA);
  const amountUSDT = ethers.parseUnits((TRADE_AMOUNT * livePrice).toFixed(6), decU);

  console.log(`Creating orders: ${TRADE_AMOUNT} tokens @ ${livePrice}`);

  const buyId = await createOrder({
    tokenIn: USDT,
    tokenOut: tokenA,
    amountIn: amountUSDT,
    amountOutMin: amountToken,
    price: livePrice,
    orderType: 0
  });

  if (buyId === null) {
    console.log("❌ BUY failed");
    return;
  }

  const sellId = await createOrder({
    tokenIn: tokenA,
    tokenOut: USDT,
    amountIn: amountToken,
    amountOutMin: amountUSDT,
    price: livePrice,
    orderType: 1
  });

  if (sellId === null) {
    console.log("❌ SELL failed");
    return;
  }

  console.log("✅ Orders created");
}

async function main() {
  console.log("\n🔄 Starting price update cycle...");
  
  // Create dummy orders first
  await ensureDummyOrders();
  
  // Then update prices
  const market = await getMarketPrices();
  if (!market) {
    console.log("❌ Failed to fetch market prices");
    return;
  }

  for (const [symbol, token] of Object.entries(TOKENS)) {
    if (symbol !== "USDT") {
      await setPriceFromLive(symbol, token, market);
    }
  }
  
  console.log("\n✅ Cycle complete");
}

console.log("🟢 Price updater started");
main();
setInterval(main, 300000);