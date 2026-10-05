import 'dotenv/config';
import path from 'node:path';

function list(v) {
  return (v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env = process.env) {
  const cfg = {
    botToken: env.BOT_TOKEN || '',
    ownerIds: list(env.OWNER_IDS).map(Number).filter(Number.isSafeInteger),
    secret: env.SECRET_KEY || '',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    baseUrl: (env.LOOTMARCH_URL || 'https://lootmarch.xyz').replace(/\/$/, ''),
    rpcUrl: env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
    chainId: Number(env.CHAIN_ID || 4663),
    explorer: (env.EXPLORER_URL || 'https://robinhoodchain.blockscout.com').replace(/\/$/, ''),
    tickSeconds: Math.max(60, Number(env.TICK_SECONDS || 300)),
    feedSeconds: Math.max(30, Number(env.FEED_SECONDS || 60)),
  };
  const missing = [];
  if (!cfg.botToken) missing.push('BOT_TOKEN');
  if (!cfg.ownerIds.length) missing.push('OWNER_IDS');
  if (cfg.secret.length < 16) missing.push('SECRET_KEY (min 16 karakter)');
  cfg.missing = missing;
  return cfg;
}
