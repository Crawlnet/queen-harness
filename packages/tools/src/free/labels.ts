// Solana addresses whose owner is public: the main exchanges' hot wallets, as the explorers label them, the multisig
// program whose vaults hold team and treasury allocations, the big AMMs' programs whose accounts holding tokens are
// pools, and the best-known tokens' mints. A label known here needs no profile call. Only addresses whose public label
// is beyond doubt and that are in use: a wrong exchange label is worse than none.

/** Exchange hot wallets: address → the exchange */
const EXCHANGE_WALLETS: Readonly<Record<string, string>> = {
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9": "Binance",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM": "Binance",
  H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS: "Coinbase",
  "2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm": "Coinbase",
  AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2: "Bybit",
  u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w: "Gate",
  BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6: "KuCoin",
  ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ: "MEXC",
};

/** An exchange's hot wallet by its address: "Binance hot wallet"; null for any other */
export const exchangeLabel = (address: string): string | null => (Object.hasOwn(EXCHANGE_WALLETS, address) ? `${EXCHANGE_WALLETS[address]} hot wallet` : null);

/** Squads' v4 multisig program: a multisig's vaults are addresses it derives from the multisig (squadsVault) */
export const SQUADS_V4 = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

/**
 * The big AMMs' programs: program → what an account of it holding tokens is. Such an account is a pool (its state, or
 * for Meteora's DAMM v1 the vault keeping a pool's tokens), never a team's or a person's (purpose unidentified"). Their
 * other accounts (an LP's position, a bin or tick array) hold no tokens and are no pool. Each checked on the chain: an
 * executable program of the upgradeable loader; a DAMM v1 pool's tokens sit in Meteora's vaults.
 */
export const POOL_PROGRAMS: Readonly<Record<string, string>> = {
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM pool",
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: "Meteora DAMM v1 pool",
  "24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi": "Meteora vault (pool liquidity)",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "Meteora DAMM v2 pool",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool pool",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM pool",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "Raydium CPMM pool",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4 pool",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap pool",
};

/** A pool program's account holding tokens by the program owning it: "Meteora DLMM pool"; null for any other program */
export const poolLabel = (program: string | null | undefined): string | null => (program && Object.hasOwn(POOL_PROGRAMS, program) ? POOL_PROGRAMS[program]! : null);

/**
 * The best-known tokens on solana by their mint: named without a metadata read, and their ticker on any other mint is a
 * copy's, no name.
 */
export const MAJOR_TOKENS: Readonly<Record<string, string>> = {
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP",
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK",
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: "WIF",
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: "PYTH",
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: "JTO",
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": "RAY",
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: "ORCA",
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL",
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "JitoSOL",
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": "POPCAT",
  "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN": "TRUMP",
  rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: "RENDER",
  hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux: "HNT",
  "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ": "W",
  ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82: "BOME",
  MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5: "MEW",
  "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv": "PENGU",
};
