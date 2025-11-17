const FACTORY_ADDRESS = "0x83DEFEcaF6079504E2DD1DE2c66DCf3046F7bDD7"; // UniswapV3Factory
const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"
];
const COINGECKO_IDS = {
  ETH: "ethereum",
  USDT: "tether",
  USDC: "usd-coin",
  MATIC: "matic-network",
  BTC: "bitcoin",
  BNB: "binancecoin",
  SOL: "solana",
  DOGE: "dogecoin",
  TRX: "tron",
  ADA: "cardano",
  HYPE: "hyperliquid",
  USDE: "usde",
  LINK: "chainlink",
  AVAX: "avalanche-2",
  XLM: "stellar",
  SUI: "sui",
  HBAR: "hedera-hashgraph",
  LEO: "leo-token",
  TON: "the-open-network",
  DOT: "polkadot",
  GALA: "gala",
  ENA: "ethena",
  LDO: "lido-dao"
};

export { FACTORY_ADDRESS, FACTORY_ABI,COINGECKO_IDS };