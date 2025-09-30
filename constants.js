export const TOKENS = {

    "USDT": {
        address: "0x8df8262960065c242c66efd42eacfb6ad971f962",
        decimals: 18,
        symbol: "USDT",
        name: "USDCT",
    },
    "USDC": {
        address: "0x654684135feea7fd632754d05e15f9886ec7bf28",
        decimals: 18,
        symbol: "USDC",
        name: "USD Coin"
    },
    "USDC ARB": {
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        decimals: 6,
        symbol: "USDC",
        name: "USD Coin"
    }
} ;

export const FEE_TIERS = [100, 500, 3000, 10000];


const SWAP_ROUTER_ADDRESS = "0x459A438Fbe3Cb71f2F8e251F181576d5a035Faef"; // SwapRouter02
const FACTORY_ADDRESS = "0x83DEFEcaF6079504E2DD1DE2c66DCf3046F7bDD7"; // UniswapV3Factory
const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"
];

export { SWAP_ROUTER_ADDRESS, FACTORY_ADDRESS,  FACTORY_ABI };