import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Game } from './game.js';
import { createBot } from './bot.js';
import { startAutopilot } from './autopilot.js';

const cfg = loadConfig();
if (cfg.missing.length) {
  console.error('Isi dulu .env: ' + cfg.missing.join(', '));
  process.exit(1);
}

const store = new Store(cfg.dataDir, cfg.secret);
// Fail fast if SECRET_KEY changed: sealed data would be unreadable later anyway.
if (store.hasWallet()) {
  try { store.privateKey(); } catch {
    console.error('SECRET_KEY tidak cocok dengan data/state.json. Pakai SECRET_KEY lama atau hapus state.json.');
    process.exit(1);
  }
}

const game = new Game({ cfg, store });
const bot = createBot({ cfg, store, game });

await bot.api.setMyCommands([
  { command: 'start', description: 'Dashboard' },
  { command: 'status', description: 'Dashboard (data segar)' },
  { command: 'afk', description: 'Klaim AFK sekarang' },
  { command: 'auto', description: 'Jalankan autopilot sekarang' },
  { command: 'log', description: 'Log aktivitas' },
  { command: 'help', description: 'Bantuan' },
]).catch((e) => console.error('[setMyCommands]', e.message));

// Session expired while the bot was off: sign in again with the key.
if (store.hasWallet() && store.data.session) {
  await game.call((a) => a.session()).catch(() => {});
} else if (store.hasWallet() && !store.data.session) {
  await game.login().then((r) => console.log('login', r.address)).catch((e) => console.error('[login]', e.message));
}

if (Date.now() - store.cursor('bootNotice') > 3600 * 1000) {
  store.setCursor('bootNotice', Date.now());
  const who = store.sessionAddress();
  bot.notify(`✅ <b>LootMarch Bot online</b>\n${who ? `Login: <code>${who}</code>\n` : 'Belum login — kirim /start.\n'}Autopilot jalan tiap ${Math.round(cfg.tickSeconds / 60)} menit. Kirim /start untuk menu.`);
}

const pilot = startAutopilot({ game, store, notify: bot.notify, tickSeconds: cfg.tickSeconds, feedSeconds: cfg.feedSeconds });

const stop = async () => { pilot.stop(); await bot.stop(); process.exit(0); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

console.log('LootMarch bot jalan. Owner:', cfg.ownerIds.join(', '));
await bot.start({ drop_pending_updates: true, onStart: (me) => console.log('@' + me.username) });
