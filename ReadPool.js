import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

// RPC + Factory
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

// Uniswap V3 Factory (same address on most chains, replace if needed)
const UNISWAP_V3_FACTORY = "0x83DEFEcaF6079504E2DD1DE2c66DCf3046F7bDD7";

// ABI for Uniswap V3 Factory
const FACTORY_ABI = [
    "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"
];

// ABI for Uniswap V3 pool
const POOL_ABI = [
    "function token0() external view returns (address)",
    "function token1() external view returns (address)"
];

// ERC20 ABI
const ERC20_ABI = [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)"
];

// ===== TOKENS =====
const TOKENS = [
    "0x61958f3DB9db9BED7beefB3Def3470f0f07629BB", // USDT
    "0x0A7d0AA33FD217A8b7818A6da40b45603C4c367E", // USDC
    "0x0703F58602aB1a8a84c1812486a8b4Cf07c5A5Da", // ETH
    "0x2bf5F367B1559a93f1FAF4A194478E707738F6bD", // MATIC
    "0x0133394e4A539F81Ec51b81dE77f1BeBF6497946", // BTC
    "0xb4753c1EDDE1D79ec36363F116D2E7DF4dec0402", // BNB
    "0xb4306EceB7Bb2a363F8344575Fc75ab388206A01", // SOL
    "0x1F35acD37d2fe4c533c1774a76F0b7dCba76D609", // DOGE
    "0xb077F3E3fC7A102BAE0D77930108c4b15e280054", // TRX
    "0x54B037Ac3b58C221e86B4f3DeD5922f7CD084769", // ADA
    "0xBd2Ae006376Bd45432153c0C08189daC2706aADF", // HYPE
    "0x5BB6551b030f3609f1076C9433Ab8A3a3BAFFa8C", // USDE
    "0x944c1FFD41Bf305b4dCc37F7D1648829b41f4758", // LINK
    "0x111915A20361a2c46a508c53Af5DeA1ed01DC0F2", // AVAX
    "0xC38C3a89460D6c57fd5f77b00c854bf7D3686C8D", // XLM
    "0x606e4b1b1405fE226C7ddC491B85Ad5003717E08", // SUI
    "0xDecfe53d2998F954709B144e846814d40ad8e9f2", // HBAR
    "0x628BaDb5E5Cc743e710dc5161bA9614fE360aBe2", // LEO
    "0xcE45Ad7F744F5186da185bdE196f429A0CB63832", // SHIB
    "0x96A95F5A25A6b3d0658e261e69965Dd9E4b0789F", // TON
    "0xCbc7Be8802E930ddC8BDf08E3bcDBd58E30B5d44", // DOT
    "0x818fE6CC6f48e4379b89f449483A8eEDEA330425", // GALA
    "0xfBCE373dC5201916CFaf627f4fCc307b9010D3e0", // ENA
    "0x9181F63E1092B65B0c6271f0D649EB1183dFd2b6", // LIDO
];

const USDT = TOKENS[0];

// Uniswap V3 fee tiers
const FEES = [100, 500, 3000, 10000];

async function scanPools() {
    const factory = new ethers.Contract(UNISWAP_V3_FACTORY, FACTORY_ABI, provider);

    for (const token of TOKENS) {
        if (token.toLowerCase() === USDT.toLowerCase()) continue;

        for (const fee of FEES) {
            const poolAddr = await factory.getPool(USDT, token, fee);

            if (poolAddr === ethers.ZeroAddress) continue;

            console.log("\n==============================");
            console.log(`POOL: USDT - ${token}`);


            // Read balances
            const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
            const [token0, token1] = await Promise.all([
                pool.token0(),
                pool.token1()
            ]);

            const t0 = new ethers.Contract(token0, ERC20_ABI, provider);
            const t1 = new ethers.Contract(token1, ERC20_ABI, provider);

            const [sym0, dec0, bal0] = await Promise.all([
                t0.symbol(),
                t0.decimals(),
                t0.balanceOf(poolAddr)
            ]);

            const [sym1, dec1, bal1] = await Promise.all([
                t1.symbol(),
                t1.decimals(),
                t1.balanceOf(poolAddr)
            ]);

            console.log(`Token0: ${sym0}  Balance: ${ethers.formatUnits(bal0, dec0)}`);
            console.log(`Token1: ${sym1}  Balance: ${ethers.formatUnits(bal1, dec1)}`);
        }
    }
}

scanPools();
