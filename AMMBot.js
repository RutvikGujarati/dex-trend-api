import { ethers } from "ethers";
import dotenv from "dotenv";
import axios from "axios";
import { createRequire } from "module";
import { COINGECKO_IDS } from "./constants.js";

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
    USDT: "0xC26efb6DB570DEE4BD0541A1ed52B590F05E3E3B",

    // ETH: "0x024b8A87BE821B27aAaecb878fDBd3F49ad3bcb2",
    USDC: "0x0A7d0AA33FD217A8b7818A6da40b45603C4c367E",
    MATIC: "0x2bf5F367B1559a93f1FAF4A194478E707738F6bD",
    BTC: "0x0133394e4A539F81Ec51b81dE77f1BeBF6497946",
    BNB: "0xb4753c1EDDE1D79ec36363F116D2E7DF4dec0402",
    SOL: "0xb4306EceB7Bb2a363F8344575Fc75ab388206A01",
    DOGE: "0x1F35acD37d2fe4c533c1774a76F0b7dCba76D609",
    TRX: "0xb077F3E3fC7A102BAE0D77930108c4b15e280054",
    ADA: "0x54B037Ac3b58C221e86B4f3DeD5922f7CD084769",
    HYPE: "0xBd2Ae006376Bd45432153c0C08189daC2706aADF",
    USDE: "0x5BB6551b030f3609f1076C9433Ab8A3a3BAFFa8C",
    LINK: "0x944c1FFD41Bf305b4dCc37F7D1648829b41f4758",
    AVAX: "0x111915A20361a2c46a508c53Af5DeA1ed01DC0F2",
    XLM: "0xC38C3a89460D6c57fd5f77b00c854bf7D3686C8D",
    SUI: "0x606e4b1b1405fE226C7ddC491B85Ad5003717E08",
    HBAR: "0xDecfe53d2998F954709B144e846814d40ad8e9f2",
    LEO: "0x628BaDb5E5Cc743e710dc5161bA9614fE360aBe2",
    TON: "0x96A95F5A25A6b3d0658e261e69965Dd9E4b0789F",
    DOT: "0xCbc7Be8802E930ddC8BDf08E3bcDBd58E30B5d44",
    GALA: "0x818fE6CC6f48e4379b89f449483A8eEDEA330425",
    ENA: "0xfBCE373dC5201916CFaf627f4fCc307b9010D3e0",
    LDO: "0x9181F63E1092B65B0c6271f0D649EB1183dFd2b6"
};
const POOL_MAP = {
    "USDC_USDT": "0xcA9b35D3F61c816246E6828440feC94bb43c8f12"
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
function getMinimalAmount(decimals) {
    return 0.01; // 0.01 smallest fraction
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
    const symA = Object.keys(TOKENS).find(k => TOKENS[k].toLowerCase() === tA.toLowerCase());
    const symB = Object.keys(TOKENS).find(k => TOKENS[k].toLowerCase() === tB.toLowerCase());

    // 🔥 Special handling for USDC/USDT
    if ((symA === "USDC" && symB === "USDT") || (symA === "USDT" && symB === "USDC")) {

        const poolAddress = POOL_MAP["USDC_USDT"];
        console.log(`  ↪ Using fixed pool address for USDC/USDT: ${poolAddress}`);

        const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
        const [p0, p1, slot0, liquidityBN] = await Promise.all([
            pool.token0(),
            pool.token1(),
            pool.slot0(),
            pool.liquidity()
        ]);

        const sqrtPriceX96 = BigInt(slot0[0].toString());
        const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
        const price = sqrtPrice ** 2;

        return {
            poolAddress,
            token0: p0,
            token1: p1,
            price,
            sqrtPrice,
            liquidity: Number(liquidityBN),
        };
    }

    // 🔥 Default logic for all other tokens
    const [token0, token1] =
        tA.toLowerCase() < tB.toLowerCase() ? [tA, tB] : [tB, tA];

    const addr = await factory.getPool(token0, token1, FEE);
    if (addr === ethers.ZeroAddress) return null;

    const pool = new ethers.Contract(addr, POOL_ABI, provider);
    const [p0, p1, slot0, liquidityBN] = await Promise.all([
        pool.token0(),
        pool.token1(),
        pool.slot0(),
        pool.liquidity()
    ]);

    const sqrtPriceX96 = BigInt(slot0[0].toString());
    const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
    const price = sqrtPrice ** 2;

    return {
        poolAddress: addr,
        token0: p0,
        token1: p1,
        price,
        sqrtPrice,
        liquidity: Number(liquidityBN)
    };
}



// =============== MARKET PRICE FETCHER ===============

async function getMarketPrices() {
    try {
        // Build CoinGecko query from token list
        const ids = Object.keys(TOKENS)
            .map(sym => COINGECKO_IDS[sym])
            .filter(Boolean)  // remove undefined
            .join(",");

        const res = await axios.get(
            `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
        );

        const data = res.data;

        const prices = {};

        for (const [symbol, id] of Object.entries(COINGECKO_IDS)) {
            if (data[id] && data[id].usd) {
                prices[symbol] = data[id].usd;
            }
        }

        return prices;

    } catch (err) {
        console.error("⚠ Failed to fetch market prices", err.message);
        return null;
    }
}


// =============== PRICE CALCULATION LOGIC ===============

function getSwapAmount(pd, tA, targetPrice, decimals) {
    const minimal = getMinimalAmount(decimals);  // use smallest safe size
    return {
        tokenIn: pd.price < targetPrice ? pd.token1 : pd.token0,
        tokenOut: pd.price < targetPrice ? pd.token0 : pd.token1,
        amount: minimal
    };
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

    const swapData = getSwapAmount(pd, tA, targetPrice, infoA.decimals);
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
        `  → Swapping ${amt.toFixed(10)} ${swapData.tokenIn === tA ? infoA.symbol : infoB.symbol} ` +
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
    console.log(`\n=== Running AMM Bot @ ${new Date().toLocaleTimeString()} ===`);

    const market = await getMarketPrices();
    if (!market) {
        console.log("Skipping run — market price fetch failed");
        return;
    }

    const tokenList = Object.entries(TOKENS);

    for (const [symbol, address] of tokenList) {
        if (symbol === "USDT") continue;

        console.log(`\n-------------------------------`);
        console.log(`Processing pair ${symbol}/USDT`);
        console.log(`-------------------------------`);

        try {
            await rebalance(address, TOKENS.USDT, market);
        } catch (err) {
            console.log(`⚠ Error on ${symbol}: ${err.message}`);
            console.log(`Skipping to next token...\n`);
            continue; // 👉 ensures next token executes
        }
    }

    console.log("\n✓ Completed full cycle.\n");
}

main();
setInterval(main, 100000);
