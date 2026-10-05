import crypto from 'node:crypto';
import { Bot, GrammyError, InlineKeyboard } from 'grammy';
import { ethers } from 'ethers';
import * as V from './views.js';
import { esc, runRound } from './autopilot.js';
import { itemInfo, itemLabel, petInfo, CAT, CLASS_LOOK, randomLook, cleanNick } from './catalog.js';
import { BUILDS } from './game.js';
import { WalletService, isAddress, parseAmount, fmtEth, fmtUnits } from './wallet.js';
import { CaptchaRequired } from './auth.js';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const TTL = 5 * 60 * 1000;

export function createBot({ cfg, store, game, autopilot }) {
  const bot = new Bot(cfg.botToken);
  const pending = new Map();   // chatId -> { kind, data, at }  (waiting for typed input)
  const confirms = new Map();  // token -> { fn, at }
  const drafts = new Map();    // chatId -> new hero draft { classId, nick, look }
  const tasks = new Set();     // long on-chain flows run here so the menu stays responsive

  // Run a slow job (waiting for blocks, polling credits) without blocking other updates.
  function background(ctx, job) {
    const t = job().catch(async (e) => {
      await say(ctx, '⚠️ ' + esc(e.shortMessage || e.message || String(e))).catch(() => {});
    }).finally(() => tasks.delete(t));
    tasks.add(t);
  }

  // ------------------------------------------------------------ guards
  bot.use(async (ctx, next) => {
    if (!ctx.from || !cfg.ownerIds.includes(ctx.from.id)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'Bot ini privat.' }).catch(() => {});
      else if (ctx.message) await ctx.reply('🔒 Bot ini privat. ID Telegram kamu: <code>' + ctx.from?.id + '</code>', HTML).catch(() => {});
      return;
    }
    return next();
  });

  // ------------------------------------------------------------ helpers
  async function show(ctx, view) {
    const opts = { ...HTML, reply_markup: view.kb };
    if (ctx.callbackQuery?.message) {
      try { return await ctx.editMessageText(view.text, opts); } catch (e) {
        if (e instanceof GrammyError && /not modified/.test(e.description)) return;
      }
    }
    return ctx.reply(view.text, opts);
  }

  // Callback queries are answered as soon as they arrive (no spinning button while
  // the slow game API works), so later toasts are delivered as a short message.
  const toast = (ctx, text) => (ctx.answered ? say(ctx, esc(text)).catch(() => {}) : ctx.answerCallbackQuery({ text: text.slice(0, 190) }).catch(() => {}));
  const say = (ctx, text, kb) => ctx.reply(text, { ...HTML, ...(kb ? { reply_markup: kb } : {}) });

  function ask(ctx, kind, prompt, data = {}) {
    pending.set(ctx.chat.id, { kind, data, at: Date.now() });
    return say(ctx, prompt + '\n\n<i>Ketik /batal untuk membatalkan.</i>');
  }

  function confirm(ctx, text, fn) {
    const token = crypto.randomBytes(6).toString('hex');
    confirms.set(token, { fn, at: Date.now() });
    for (const [k, v] of confirms) if (Date.now() - v.at > TTL) confirms.delete(k);
    return show(ctx, { text: '❓ ' + text, kb: V.confirmKb(token) });
  }

  // Sign in with the stored key on demand; only complain when there is no key at all.
  bot.use(async (ctx, next) => {
    if (!store.data.session && store.hasWallet()) await game.ensureSession().catch(() => {});
    return next();
  });
  const needLogin = () => {
    if (!store.data.session) throw new Error(store.hasWallet() ? 'Login game gagal, coba ⚙️ → 🔐 Login ulang.' : 'Belum ada wallet. Buka 💰 Wallet → 🔑 Import key.');
  };

  async function home(ctx, fresh = false) {
    if (!store.data.session) {
      const addr = store.walletAddress();
      return show(ctx, {
        text: ['⚔️ <b>LootMarch Bot</b>', '', addr ? `Wallet: <code>${addr}</code>` : 'Belum ada wallet.', '', addr ? 'Tekan 🔐 Login untuk masuk ke game dengan private key.' : 'Langkah 1: import private key wallet yang kamu pakai di lootmarch.xyz.'].join('\n'),
        kb: addr
          ? new InlineKeyboard().text('🔐 Login', 'set:login').text('💰 Wallet', 'nav:wallet')
          : new InlineKeyboard().text('🔑 Import key', 'w:import').text('✨ Buat wallet baru', 'w:new'),
      });
    }
    if (game.needsHero(await game.state(10000))) return show(ctx, V.newHeroClassView());
    const [st, live, online, daily, pass] = await Promise.all([
      game.state(fresh ? 0 : 10000),
      game.live(fresh ? 0 : 60000).catch(() => null),
      game.online(),
      game.cached('daily', fresh ? 0 : 60000, () => game.daily()).catch(() => null),
      game.cached('pass', fresh ? 0 : 60000, () => game.pass()).catch(() => null),
    ]);
    const s = store.settings;
    const afkAt = store.cursor('afkAt');
    return show(ctx, V.homeView(st, {
      live, online, daily, pass, settings: s, autopilot: true, desktopUrl: cfg.desktopUrl,
      lastRun: store.cursor('lastRun'),
      nextAfkIn: afkAt ? (afkAt + s.afkHours * 3600000 - Date.now()) / 1000 : 0,
      travelIn: game.travelReadyIn(st),
    }));
  }

  // Wrap every handler: errors become a toast + message instead of a crash.
  const h = (fn) => async (ctx) => {
    if (ctx.callbackQuery) { ctx.answered = true; ctx.answerCallbackQuery().catch(() => {}); }
    try {
      await fn(ctx);
    } catch (e) {
      const msg = e instanceof CaptchaRequired
        ? '🛡 Server minta captcha untuk login. Login sekali di browser, lalu kirim header Cookie lewat perintah /cookie.'
        : '⚠️ ' + (e.shortMessage || e.message || String(e));
      await say(ctx, esc(msg)).catch(() => {});
    }
  };

  async function walletScreen(ctx) {
    const address = store.walletAddress();
    let eth = null; let lm = null; let dep = null; let wd = null;
    let st = null;
    if (address) {
      const s = !!store.data.session;
      const [b, d, w, g] = await Promise.all([
        game.walletBalances().catch(() => null),
        s ? game.depositInfo().catch(() => null) : null,
        s ? game.withdrawInfo().catch(() => null) : null,
        s ? game.state(20000).catch(() => null) : null,
      ]);
      eth = b?.eth ?? null; lm = b?.lm ?? null; dep = d; wd = w; st = g;
    }
    return show(ctx, V.walletView({ address, eth, lm, game: st?.balances?.LM, dep, wd, explorer: cfg.explorer, fmtEth, fmtLm: (v) => fmtUnits(v, 18, 2) }));
  }

  const txLink = (hash) => `<a href="${cfg.explorer}/tx/${hash}">${hash.slice(0, 10)}…</a>`;

  // ------------------------------------------------------------ commands
  bot.command(['start', 'menu'], h((ctx) => home(ctx)));
  bot.command('batal', h(async (ctx) => { pending.delete(ctx.chat.id); await say(ctx, 'Dibatalkan.'); }));
  bot.command('status', h(async (ctx) => { needLogin(); await home(ctx, true); }));
  bot.command('log', h(async (ctx) => show(ctx, V.logView(store.logs(30)))));
  bot.command('afk', h(async (ctx) => {
    needLogin();
    const r = await game.afkClaim();
    await say(ctx, `💤 AFK diklaim: +${V.n(r.rewards?.lm)} $LM · +${V.n(r.rewards?.xp)} XP · +${V.n(r.rewards?.bone)} Bone`);
  }));
  async function runAutopilotNow(ctx) {
    const m = await say(ctx, '🤖 Menjalankan autopilot…');
    const { log, errors } = await runRound(game, store);
    store.setCursor('lastRun', Date.now());
    for (const l of log) store.addLog(l.replace(/<[^>]+>/g, ''), 'manual');
    for (const e of errors) store.addLog('⚠️ ' + e, 'manual');
    const text = [log.length ? log.join('\n') : '✅ Semua sudah beres, tidak ada yang perlu dikerjakan sekarang.', ...errors.map((e) => '⚠️ ' + esc(e))].join('\n');
    await ctx.api.editMessageText(ctx.chat.id, m.message_id, '🤖 <b>Autopilot</b>\n' + text, HTML).catch(() => say(ctx, text));
  }
  bot.command('auto', h(async (ctx) => { needLogin(); await runAutopilotNow(ctx); }));
  bot.command('cookie', h(async (ctx) => ask(ctx, 'cookie', '🍪 Kirim isi header <b>Cookie</b> dari lootmarch.xyz (DevTools → Application → Cookies, atau header cookie request /api/*).')));
  bot.command('help', h(async (ctx) => say(ctx, [
    '<b>Perintah</b>', '/start — dashboard', '/status — dashboard (data segar)', '/log — log aktivitas', '/afk — klaim AFK sekarang', '/auto — jalankan autopilot sekarang', '/batal — batalkan input',
  ].join('\n'))));

  // ------------------------------------------------------------ navigation
  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());
  bot.callbackQuery('nav:home', h((ctx) => home(ctx)));
  bot.callbackQuery('nav:refresh', h((ctx) => home(ctx, true)));
  bot.callbackQuery('nav:log', h(async (ctx) => show(ctx, V.logView(store.logs(30)))));
  bot.callbackQuery('auto:run', h(async (ctx) => { needLogin(); await runAutopilotNow(ctx); }));
  const ST = 20000; // menus may show state up to 20 s old; every action refreshes it
  bot.callbackQuery('nav:hero', h(async (ctx) => { needLogin(); await show(ctx, V.heroView(await game.state(ST), store.settings)); }));
  bot.callbackQuery(/^nav:inv:(\d+)$/, h(async (ctx) => { needLogin(); const st = await game.state(ST); await show(ctx, V.invView(game.inventory(st), +ctx.match[1])); }));
  bot.callbackQuery('nav:loot', h(async (ctx) => { needLogin(); await show(ctx, V.lootView(await game.state(ST), null)); }));
  bot.callbackQuery('nav:quest', h(async (ctx) => { needLogin(); await show(ctx, V.questView(await game.daily())); }));
  bot.callbackQuery('nav:pass', h(async (ctx) => { needLogin(); const [p, st] = await Promise.all([game.pass(), game.state(ST)]); await show(ctx, V.passView(p, st)); }));
  bot.callbackQuery(/^nav:travel(?::(\d+))?$/, h(async (ctx) => {
    needLogin();
    const st = await game.state(ST);
    await show(ctx, V.travelView(st, game.travelReadyIn(st), ctx.match[1] ? +ctx.match[1] : null));
  }));
  bot.callbackQuery('nav:pet', h(async (ctx) => { needLogin(); await show(ctx, V.petView(await game.state(ST))); }));
  bot.callbackQuery('nav:shop', h(async (ctx) => { needLogin(); await show(ctx, V.shopView(await game.state(ST))); }));
  bot.callbackQuery('nav:codex', h(async (ctx) => { needLogin(); await show(ctx, V.codexView(await game.state(ST))); }));
  bot.callbackQuery('nav:ranks', h(async (ctx) => { needLogin(); await show(ctx, V.ranksView(await game.cached('ranks', 60000, () => game.call((a) => a.leaderboard())))); }));
  bot.callbackQuery('nav:wallet', h(walletScreen));
  bot.callbackQuery('nav:set', h(async (ctx) => show(ctx, V.settingsView(store.settings, { address: store.walletAddress(), session: store.sessionAddress() }))));
  bot.callbackQuery(/^nav:mk:(\w+):(\w+):(\d+)$/, h(async (ctx) => {
    needLogin();
    const [, rarity, slot, page] = ctx.match;
    const [data, st] = await Promise.all([game.market({ rarity: rarity === 'all' ? '' : rarity, slot: slot === 'all' || slot === 'pet' ? '' : slot }), game.state(ST)]);
    await show(ctx, V.marketView(st, data, { rarity, slot, page: +page }));
  }));

  // ------------------------------------------------------------ confirmations
  bot.callbackQuery(/^cf:([0-9a-f]+)$/, h(async (ctx) => {
    const c = confirms.get(ctx.match[1]);
    confirms.delete(ctx.match[1]);
    if (!c || Date.now() - c.at > TTL) throw new Error('Konfirmasi sudah kedaluwarsa, ulangi dari menu.');
    await c.fn(ctx);
  }));

  // ------------------------------------------------------------ hero
  bot.callbackQuery(/^hero:attr:(\w+)$/, h(async (ctx) => {
    await game.addAttribute(ctx.match[1], 1);
    await show(ctx, V.heroView(game.last, store.settings));
  }));
  bot.callbackQuery('hero:auto', h(async (ctx) => {
    const next = await game.autoAttributes(store.settings.build);
    await toast(ctx, next ? 'Attribute dialokasikan.' : 'Tidak ada poin bebas.');
    await show(ctx, V.heroView(game.last, store.settings));
  }));
  bot.callbackQuery('hero:best', h(async (ctx) => {
    await game.equipBest();
    await toast(ctx, '🧥 Gear terbaik dipasang.');
    await show(ctx, V.heroView(game.last, store.settings));
  }));
  bot.callbackQuery('hero:build', h(async (ctx) => show(ctx, V.buildPicker(store.settings.build, game.last?.character?.classId))));
  bot.callbackQuery(/^hero:setbuild:(\w+)$/, h(async (ctx) => {
    if (!BUILDS[ctx.match[1]]) throw new Error('Build tidak dikenal.');
    store.setSetting('build', ctx.match[1]);
    await show(ctx, V.buildPicker(store.settings.build, game.last?.character?.classId));
  }));

  // ------------------------------------------------------------ new hero
  bot.callbackQuery('new:start', h(async (ctx) => { needLogin(); await show(ctx, V.newHeroClassView()); }));
  bot.callbackQuery(/^new:class:(\w+)$/, h(async (ctx) => {
    const classId = ctx.match[1];
    if (!CLASS_LOOK[classId]) throw new Error('Class tidak dikenal.');
    const d = drafts.get(ctx.chat.id) || {};
    drafts.set(ctx.chat.id, { ...d, classId, look: { ...CLASS_LOOK[classId] } });
    if (d.nick) return show(ctx, V.newHeroLookView(drafts.get(ctx.chat.id)));
    await ask(ctx, 'nick', `🆕 <b>Buat hero</b> — langkah 2/3\nKetik <b>nama hero</b> (${V.NICK_RULE}). Nama tampil di Ranks.`);
  }));
  bot.callbackQuery('new:nick', h(async (ctx) => ask(ctx, 'nick', `Ketik nama hero baru (${V.NICK_RULE}).`)));
  bot.callbackQuery(/^new:look:(rand|def)$/, h(async (ctx) => {
    const d = drafts.get(ctx.chat.id);
    if (!d?.classId) return show(ctx, V.newHeroClassView());
    d.look = ctx.match[1] === 'rand' ? randomLook() : { ...CLASS_LOOK[d.classId] };
    await show(ctx, V.newHeroLookView(d));
  }));
  bot.callbackQuery('new:go', h(async (ctx) => {
    const d = drafts.get(ctx.chat.id);
    if (!d?.classId || !d.nick) return show(ctx, V.newHeroClassView());
    await game.createHero(d.classId, d.nick, d.look);
    store.addLog(`Hero dibuat: ${d.nick} (${d.classId})`, 'manual');
    drafts.delete(ctx.chat.id);
    await say(ctx, `🎉 Hero <b>${esc(d.nick)}</b> (${d.classId.toUpperCase()}) siap berpetualang! Autopilot mulai mengurus loot, quest & attribute.`);
    await home(ctx);
  }));

  // ------------------------------------------------------------ market upgrades
  bot.callbackQuery('upg:plan', h(async (ctx) => { needLogin(); const plan = await game.upgradePlan(); await show(ctx, V.upgradeView(game.last, plan)); }));
  bot.callbackQuery('upg:buy', h(async (ctx) => {
    const plan = await game.upgradePlan();
    if (!plan.picks.length) throw new Error('Tidak ada upgrade yang terjangkau sekarang.');
    await confirm(ctx, `Beli ${plan.picks.length} gear seharga total <b>${V.n(plan.spend)} $LM</b> dan langsung dipakai? (Power +${V.n(plan.gain)})`, async (c) => {
      const p0 = plan.base;
      const { done, failed } = await game.buyUpgrades(plan.picks);
      if (done.length) store.addLog(`Upgrade market: ${done.map((p) => itemInfo(p.listing.itemId).name).join(', ')}`, 'manual');
      const st = await game.state();
      const { heroPower } = await import('./catalog.js');
      await say(c, [`🛍 Dibeli ${done.length} gear:`, ...done.map((p) => '• ' + itemLabel(p.listing.itemId)), ...failed.map((p) => `⚠️ ${itemLabel(p.listing.itemId)}: ${esc(p.error)}`), '', `⚡ Power ${V.n(p0)} → <b>${V.n(heroPower(st))}</b>`].join('\n'));
      await show(c, V.heroView(st, store.settings));
    });
  }));

  // ------------------------------------------------------------ items
  bot.callbackQuery(/^it:v:(.+)$/, h(async (ctx) => show(ctx, V.itemView(await game.state(10000), ctx.match[1]))));
  bot.callbackQuery(/^it:eq:(.+)$/, h(async (ctx) => { await game.equip(ctx.match[1]); await show(ctx, V.itemView(game.last, ctx.match[1])); }));
  bot.callbackQuery(/^it:un:(\w+)$/, h(async (ctx) => { await game.unequip(ctx.match[1]); await show(ctx, V.heroView(game.last, store.settings)); }));
  bot.callbackQuery(/^it:fg:(.+):(\d+)$/, h(async (ctx) => {
    const [, id, steps] = ctx.match;
    const before = game.last?.balances || {};
    const res = await game.forge(id, +steps);
    const after = game.last?.balances || {};
    const newId = res.itemId || res.item || Object.keys(game.last?.items || {}).find((k) => k.startsWith(itemInfo(id).baseId + '@') && !(k in (before.items || {}))) || id;
    await say(ctx, `🔨 Forge berhasil: ${itemLabel(newId)}\nBiaya: ${V.n((before.LM || 0) - (after.LM || 0))} $LM · ${V.n((before.Bone || 0) - (after.Bone || 0))} Bone`);
    await show(ctx, V.itemView(game.last, game.last?.items?.[newId] ? newId : id));
  }));
  bot.callbackQuery(/^it:del:(.+)$/, h(async (ctx) => confirm(ctx, `Buang 1× ${itemLabel(ctx.match[1])}? Tidak bisa dibatalkan.`, async (c) => {
    await game.call((a) => a.destroy(ctx.match[1], 1)).then((r) => game.keep(r));
    await show(c, V.invView(game.inventory(game.last), 0));
  })));
  bot.callbackQuery(/^it:sell:(.+)$/, h(async (ctx) => {
    const id = ctx.match[1];
    const name = id.includes(':') ? petInfo(id).name : itemLabel(id);
    await ask(ctx, 'sell', `🏪 Jual <b>${esc(name)}</b>\nKetik harga dalam $LM (contoh <code>1500</code> atau <code>2k</code>). Fee listing 2,5% dibayar di depan.`, { id });
  }));
  bot.callbackQuery('salv:menu', h(async (ctx) => show(ctx, V.salvageView(await game.state(ST)))));
  bot.callbackQuery(/^salv:(\d)$/, h(async (ctx) => {
    const lvl = +ctx.match[1];
    await confirm(ctx, `Salvage semua gear cadangan sampai rarity <b>${CAT.rarities[lvl]}</b>? (1 copy tiap item disisakan)`, async (c) => {
      const b0 = game.last?.balances?.Bone || 0;
      await game.salvage(lvl);
      await say(c, `♻️ Salvage selesai: +${V.n((game.last?.balances?.Bone || 0) - b0)} Bone`);
      await show(c, V.invView(game.inventory(game.last), 0));
    });
  }));

  // ------------------------------------------------------------ loot & afk
  bot.callbackQuery('loot:claim', h(async (ctx) => {
    const r = await game.lootClaim();
    await toast(ctx, `🎁 +${r.claimed?.bone || 0} Bone · ${r.claimed?.items || 0} item`);
    await show(ctx, V.lootView(game.last, null));
  }));
  bot.callbackQuery('afk:prev', h(async (ctx) => {
    const [st, afk] = await Promise.all([game.state(20000), game.afkPreview()]);
    await show(ctx, V.lootView(st, afk));
  }));
  bot.callbackQuery('afk:claim', h(async (ctx) => {
    const r = await game.afkClaim();
    store.setCursor('afkAt', Date.now());
    await say(ctx, `💤 AFK ${V.dur(r.seconds)}: +${V.n(r.rewards?.lm)} $LM · +${V.n(r.rewards?.xp)} XP · +${V.n(r.rewards?.bone)} Bone`);
    await show(ctx, V.lootView(game.last, null));
  }));

  // ------------------------------------------------------------ quests & pass
  bot.callbackQuery('quest:claim', h(async (ctx) => {
    const got = await game.claimDailyAll();
    await toast(ctx, got.length ? 'Diklaim: ' + got.join(', ') : 'Belum ada yang bisa diklaim.');
    await show(ctx, V.questView(await game.daily()));
  }));
  bot.callbackQuery('pass:claim', h(async (ctx) => {
    await game.act((a) => a.claimPass());
    await show(ctx, V.passView(await game.pass(), game.last));
  }));
  bot.callbackQuery('pass:calc', h(async (ctx) => {
    const p = await game.pass(); const st = await game.state(30000);
    const rows = [1000, 600, 400].map((d) => ({ d, ...V.passCalc(p, st, d) }));
    const text = ['🧮 <b>Analisa March Pass Premium</b>', `Harga: <b>$${p.premiumUsd}</b> (${V.n(p.premiumLmPrice)} $LM atau ETH)`, `Tier sekarang ${p.tier}, sisa season ${rows[0].daysLeft.toFixed(1)} hari.`, '',
      ...rows.map((r) => `• <b>${r.d} pass XP/hari</b> → sampai tier ${r.reach}: ${V.n(r.lm)} $LM + ${V.n(r.bone)} Bone + chest ≈ <b>$${r.value.toFixed(2)}</b> ${r.value > r.cost ? '✅ untung' : '❌ rugi'} (${((r.value / r.cost - 1) * 100).toFixed(0)}%)`),
      '', '<i>1.000 XP/hari = 80 room online + semua misi + daily reward. AFK tidak memberi pass XP dari room. Nilai $LM dihitung pakai harga sekarang; jumlah $LM dikunci saat beli. Tier yang sudah tercapai langsung cair saat beli, jadi tidak rugi menunggu sampai yakin.</i>'];
    await show(ctx, { text: text.join('\n'), kb: new InlineKeyboard().text('⬅️ Kembali', 'nav:pass') });
  }));
  bot.callbackQuery('pass:buylm', h(async (ctx) => {
    const p = await game.pass();
    await confirm(ctx, `Beli March Pass Premium seharga <b>${V.n(p.premiumLmPrice)} $LM</b> ($${p.premiumUsd}) dari saldo game?`, async (c) => {
      await game.act((a) => a.buyPass(Math.ceil(p.premiumLmPrice * 1.03)));
      await say(c, '♛ Premium Pass aktif!');
      await show(c, V.passView(await game.pass(), game.last));
    });
  }));
  bot.callbackQuery('pass:buyeth', h(async (ctx) => ethPay(ctx, 'march_pass', 'March Pass Premium')));

  // ------------------------------------------------------------ travel & floors
  bot.callbackQuery(/^tr:go:(\d+):(\d+)$/, h(async (ctx) => {
    const [, f, z] = ctx.match.map(Number);
    const wait = game.travelReadyIn(await game.state());
    if (wait) throw new Error(`Travel cooldown, tunggu ${V.dur(wait)} lagi.`);
    await confirm(ctx, `Travel ke Floor ${f} · ${esc(CAT.regions[z]?.name)}? Region dimulai dari room pertama, cooldown 30 menit.`, async (c) => {
      await game.travel(f, z);
      await show(c, V.travelView(game.last, game.travelReadyIn(game.last)));
    });
  }));
  bot.callbackQuery(/^tr:seal:(\d+)$/, h(async (ctx) => {
    const f = +ctx.match[1];
    const { sealCost } = await import('./catalog.js');
    const cost = sealCost(f);
    await confirm(ctx, `Buka seal Floor ${f} seharga ${V.n(cost.lm)} $LM + ${V.n(cost.bone)} Bone?`, async (c) => {
      await game.unlockFloor(f);
      await say(c, `🔓 Floor ${f} terbuka!`);
      await show(c, V.travelView(game.last, game.travelReadyIn(game.last), f));
    });
  }));

  // ------------------------------------------------------------ shop
  bot.callbackQuery(/^shop:c:(\w+)$/, h(async (ctx) => show(ctx, V.chestView(await game.state(ST), ctx.match[1]))));
  bot.callbackQuery(/^shop:buy:(\w+)$/, h(async (ctx) => {
    const id = ctx.match[1]; const st = await game.state();
    const price = st.prices?.chests?.[id];
    await confirm(ctx, `Beli <b>${itemInfo(id).name}</b> seharga ${V.n(price)} $LM${V.usd(price, st)}?`, async (c) => {
      const r = await game.buyChest(id);
      store.addLog(`Beli ${itemInfo(id).name}`, 'manual');
      await say(c, '📦 Chest dibeli' + revealText(r));
      await show(c, V.chestView(game.last, id));
    });
  }));
  bot.callbackQuery(/^shop:eth:(\w+)$/, h(async (ctx) => ethPay(ctx, ctx.match[1], itemInfo(ctx.match[1]).name, () => game.openChest(ctx.match[1]))));
  bot.callbackQuery(/^shop:open:(\w+)$/, h(async (ctx) => {
    const r = await game.openChest(ctx.match[1]);
    await say(ctx, '📦 Chest dibuka' + revealText(r));
    await show(ctx, V.chestView(game.last, ctx.match[1]));
  }));
  bot.callbackQuery(/^shop:p:(\w+)$/, h(async (ctx) => {
    const t = ctx.match[1]; const st = await game.state(ST);
    const price = st.petChestTestLm?.prices?.[t];
    const kb = new InlineKeyboard();
    if (price) kb.text(`💰 Beli & buka (${V.n(price)} $LM)`, 'shop:pbuy:' + t).row();
    kb.text('Ξ Beli pakai ETH', 'shop:peth:' + t).row().text('⬅️ Kembali', 'nav:shop');
    const odds = Object.entries(CAT.petChests[t]?.drops || {}).map(([r, w]) => `${r} ${(w / 100).toFixed(w < 100 ? 2 : 0)}%`).join(' · ');
    await show(ctx, { text: `🐾 <b>${CAT.petChests[t]?.name || t}</b> ($${CAT.petChestUsd[t]})\nPeluang: ${odds}\nPunya: ${st.petChests?.[t] || 0}`, kb });
  }));
  bot.callbackQuery(/^shop:pbuy:(\w+)$/, h(async (ctx) => {
    const t = ctx.match[1]; const st = await game.state();
    await confirm(ctx, `Beli & buka ${CAT.petChests[t]?.name} seharga ${V.n(st.petChestTestLm?.prices?.[t])} $LM?`, async (c) => {
      const r = await game.openPetChest(t);
      await say(c, '🐾 Pet chest dibuka' + revealText(r));
      await show(c, V.petView(game.last));
    });
  }));
  bot.callbackQuery(/^shop:popen:(\w+)$/, h(async (ctx) => {
    const r = await game.openPetChest(ctx.match[1]);
    await say(ctx, '🐾 Pet chest dibuka' + revealText(r));
    await show(ctx, V.petView(game.last));
  }));
  bot.callbackQuery(/^shop:peth:(\w+)$/, h(async (ctx) => ethPay(ctx, 'pet_chest_' + ctx.match[1], CAT.petChests[ctx.match[1]]?.name, () => game.openPetChest(ctx.match[1]))));
  bot.callbackQuery(/^shop:bone:(\d+)$/, h(async (ctx) => {
    const packs = +ctx.match[1]; const bp = (await game.state()).prices?.bonePack;
    await confirm(ctx, `Beli ${packs} bone pack (${V.n(bp.bone * packs)} Bone) seharga ${V.n(bp.lm * packs)} $LM?`, async (c) => {
      await game.buyBone(packs);
      await show(c, V.shopView(game.last));
    });
  }));

  function revealText(r) {
    const got = r?.items || r?.drops || r?.rewards?.items || (r?.itemId ? [r.itemId] : r?.item ? [r.item] : r?.petId ? [r.petId] : r?.pet ? [r.pet] : []);
    const list = (Array.isArray(got) ? got : [got]).map((x) => (typeof x === 'string' ? x : x?.itemId || x?.petId || x?.id)).filter(Boolean);
    if (!list.length) return '.';
    return ':\n' + list.map((id) => '• ' + (String(id).includes(':') ? `🐾 ${esc(petInfo(id).name)}` : itemLabel(id))).join('\n');
  }

  async function ethPay(ctx, product, label, after = null) {
    if (!store.hasWallet()) throw new Error('Wallet belum di-set.');
    const q = await game.call((a) => a.ethQuote(product));
    await confirm(ctx, `Bayar <b>${esc(label)}</b> dengan <b>${q.eth ?? fmtEth(q.wei)} ETH</b> dari wallet bot ke <code>${q.to}</code>?`, async (c) => background(c, async () => {
      const m = await say(c, '⏳ Mengirim ETH…');
      const edit = (t) => c.api.editMessageText(c.chat.id, m.message_id, t, HTML).catch(() => {});
      const w = game.wallet();
      const tx = await w.sendWei(q.to, q.wei);
      await edit(`⏳ Menunggu konfirmasi ${txLink(tx.hash)}…`);
      await w.wait(tx);
      await edit(`⏳ Menunggu game mengkredit ${txLink(tx.hash)}…`);
      let r = await game.pollUntilCredited((a) => a.ethClaim(q.quoteId, tx.hash), 120);
      if (after) r = await after().catch(() => r); // the web client opens paid chests right away too
      store.addLog(`Bayar ${label} pakai ETH (${tx.hash})`, 'manual');
      await edit(`✅ <b>${esc(label)}</b> dibayar ${txLink(tx.hash)}` + revealText(r));
    }));
  }

  // ------------------------------------------------------------ pets
  bot.callbackQuery(/^pet:v:(.+)$/, h(async (ctx) => show(ctx, V.petDetail(await game.state(10000), ctx.match[1]))));
  bot.callbackQuery(/^pet:eq:(.+)$/, h(async (ctx) => {
    const id = ctx.match[1] === 'none' ? null : ctx.match[1];
    await game.equipPet(id);
    await show(ctx, V.petView(game.last));
  }));
  bot.callbackQuery(/^pet:feed:(.+):(\d+)$/, h(async (ctx) => {
    const [, id, bone] = ctx.match;
    await confirm(ctx, `Feed ${esc(petInfo(id).name)} dengan ${V.n(bone)} Bone (+${V.n(bone)} $LM biaya)?`, async (c) => {
      await game.feedPet(id, +bone);
      await show(c, V.petDetail(game.last, id));
    });
  }));

  // ------------------------------------------------------------ market
  bot.callbackQuery(/^mk:v:(.+)$/, h(async (ctx) => {
    const [data, st] = await Promise.all([game.market({}), game.state(ST)]);
    const l = (data.listings || []).find((x) => x.id === ctx.match[1]);
    if (!l) throw new Error('Listing sudah tidak ada (mungkin sudah terjual).');
    await show(ctx, V.listingView(st, l));
  }));
  bot.callbackQuery(/^mk:buy:(.+)$/, h(async (ctx) => {
    const data = await game.market({});
    const l = (data.listings || []).find((x) => x.id === ctx.match[1]);
    if (!l) throw new Error('Listing sudah tidak ada.');
    await confirm(ctx, `Beli ${String(l.itemId).includes(':') ? esc(petInfo(l.itemId).name) : itemLabel(l.itemId)} seharga ${V.n(l.price)} $LM (+5% fee = ${V.n(Math.ceil(l.price * 1.05))})?`, async (c) => {
      await game.marketBuy(l.id);
      await say(c, '🛒 Berhasil dibeli, masuk ke inventory.');
      await show(c, V.invView(game.inventory(game.last), 0));
    });
  }));
  bot.callbackQuery('mk:mine', h(async (ctx) => show(ctx, V.myListingsView(await game.state(ST)))));
  bot.callbackQuery(/^mk:cancel:(.+)$/, h(async (ctx) => confirm(ctx, 'Batalkan listing ini? Item kembali, fee 2,5% tidak kembali.', async (c) => {
    await game.marketCancel(ctx.match[1]);
    await show(c, V.myListingsView(game.last));
  })));
  bot.callbackQuery('mk:hist', h(async (ctx) => show(ctx, V.historyView(await game.marketHistory(), game.last?.character?.appearance?.nick))));

  // ------------------------------------------------------------ wallet
  bot.callbackQuery('w:import', h(async (ctx) => ask(ctx, 'key', '🔑 Kirim <b>private key</b> wallet kamu (64 hex). Pesan kamu langsung dihapus, key disimpan terenkripsi AES-256-GCM di server bot.')));
  bot.callbackQuery('w:new', h(async (ctx) => confirm(ctx, store.hasWallet() ? 'Buat wallet BARU? Wallet lama diganti (pastikan key lama sudah kamu simpan).' : 'Buat wallet baru?', async (c) => {
    const w = WalletService.create();
    store.setWallet(w.address, w.privateKey);
    store.clearSession();
    const m = await say(c, `✨ Wallet baru:\n<code>${w.address}</code>\n\nPrivate key (SIMPAN, pesan ini terhapus otomatis 60 detik):\n<tg-spoiler><code>${w.privateKey}</code></tg-spoiler>`);
    setTimeout(() => c.api.deleteMessage(c.chat.id, m.message_id).catch(() => {}), 60000);
  })));
  bot.callbackQuery('w:reveal', h(async (ctx) => confirm(ctx, 'Tampilkan private key? Pesan terhapus otomatis setelah 60 detik.', async (c) => {
    const m = await say(c, `🔑 <tg-spoiler><code>${store.privateKey()}</code></tg-spoiler>`);
    setTimeout(() => c.api.deleteMessage(c.chat.id, m.message_id).catch(() => {}), 60000);
  })));
  bot.callbackQuery('w:dep', h(async (ctx) => {
    needLogin();
    const d = await game.depositInfo();
    if (!d.open) throw new Error('Deposit belum dibuka oleh game.');
    await ask(ctx, 'dep', `⬇️ <b>Deposit $LM</b>\nToken <code>${d.token}</code> dikirim dari wallet bot ke treasury <code>${d.treasury}</code>, lalu dikredit 1:1 ke saldo game.\n\nKetik jumlah $LM (contoh <code>5000</code> atau <code>10k</code>).`);
  }));
  bot.callbackQuery('w:claim', h(async (ctx) => { needLogin(); await ask(ctx, 'claim', '🧾 Kirim tx hash transfer $LM ke treasury (0x…64 hex).'); }));
  bot.callbackQuery('w:wd', h(async (ctx) => {
    needLogin();
    const w = await game.withdrawInfo();
    await ask(ctx, 'wd', `⬆️ <b>Withdraw</b>\nMin ${V.n(w.min)} · maks ${V.n(w.max)} $LM · ${w.perDay}×/hari (reset 00:00 UTC) · dipakai hari ini ${w.usedToday}\nWallet harus pegang ≥ ${V.n(w.holdMin)} $LM on-chain (sekarang ${V.n(w.held)}).\nDibayar setelah review; kalau ditolak saldo kembali.\n\nKetik jumlah $LM.`);
  }));
  bot.callbackQuery(/^w:send:(eth|lm)$/, h(async (ctx) => ask(ctx, 'sendTo', `📤 Kirim ${ctx.match[1] === 'eth' ? 'ETH' : '$LM'}: ketik alamat tujuan (0x…).`, { kind: ctx.match[1] })));

  // ------------------------------------------------------------ settings
  bot.callbackQuery(/^set:t:(\w+)$/, h(async (ctx) => {
    const k = ctx.match[1];
    if (typeof store.settings[k] !== 'boolean') throw new Error('Setelan tidak dikenal.');
    store.setSetting(k, !store.settings[k]);
    await show(ctx, V.settingsView(store.settings, { address: store.walletAddress(), session: store.sessionAddress() }));
  }));
  bot.callbackQuery('set:afk', h(async (ctx) => {
    const opts = [2, 4, 6, 8];
    store.setSetting('afkHours', opts[(opts.indexOf(store.settings.afkHours) + 1) % opts.length]);
    await show(ctx, V.settingsView(store.settings, { address: store.walletAddress(), session: store.sessionAddress() }));
  }));
  bot.callbackQuery('set:salv', h(async (ctx) => {
    store.setSetting('salvageLevel', (store.settings.salvageLevel + 1) % 3);
    await show(ctx, V.settingsView(store.settings, { address: store.walletAddress(), session: store.sessionAddress() }));
  }));
  bot.callbackQuery('set:fres', h(async (ctx) => ask(ctx, 'fres', '🔨 Ketik cadangan $LM minimum untuk auto forge (contoh <code>5000</code>).')));
  bot.callbackQuery('set:login', h(async (ctx) => {
    await toast(ctx, '🔐 Login…');
    const r = await game.login();
    await say(ctx, `✅ Login sebagai <code>${r.address}</code>${r.created ? ' (akun baru dibuat)' : ''}`);
    await home(ctx);
  }));
  bot.callbackQuery('set:logout', h(async (ctx) => confirm(ctx, 'Logout dari game? Autopilot berhenti sampai login lagi.', async (c) => {
    await game.logout();
    await home(c);
  })));

  // ------------------------------------------------------------ typed input
  bot.on('message:text', h(async (ctx) => {
    const p = pending.get(ctx.chat.id);
    const text = ctx.message.text.trim();
    if (!p || text.startsWith('/')) return;
    if (Date.now() - p.at > TTL) { pending.delete(ctx.chat.id); throw new Error('Input kedaluwarsa, ulangi dari menu.'); }
    const secret = p.kind === 'key' || p.kind === 'cookie';
    if (secret) await ctx.deleteMessage().catch(() => {});
    pending.delete(ctx.chat.id);

    switch (p.kind) {
      case 'key': {
        const w = WalletService.fromKey(text);
        store.setWallet(w.address, w.privateKey);
        store.clearSession();
        await say(ctx, `✅ Wallet diset: <code>${w.address}</code>\nMencoba login…`);
        try {
          const r = await game.login();
          await say(ctx, `✅ Login game sebagai <code>${r.address}</code>`);
        } catch (e) {
          if (e instanceof CaptchaRequired) await say(ctx, '🛡 Server minta captcha untuk login otomatis. Login sekali di browser lalu kirim header Cookie lewat /cookie. Wallet tetap tersimpan untuk deposit/kirim.');
          else throw e;
        }
        return home(ctx);
      }
      case 'nick': {
        const nick = cleanNick(text);
        if (!nick) { await ask(ctx, 'nick', `❌ Nama tidak valid. ${V.NICK_RULE}. Coba lagi:`); return undefined; }
        const d = drafts.get(ctx.chat.id);
        if (!d?.classId) return show(ctx, V.newHeroClassView());
        d.nick = nick;
        return show(ctx, V.newHeroLookView(d));
      }
      case 'cookie': {
        const addr = await game.useCookie(text.replace(/^cookie:\s*/i, ''));
        await say(ctx, `✅ Session aktif untuk <code>${addr}</code>`);
        return home(ctx);
      }
      case 'sell': {
        const price = Math.round(Number(parseAmount(text)));
        if (!(price > 0)) throw new Error('Harga tidak valid.');
        const fee = Math.ceil(price * 0.025);
        return confirm(ctx, `List ${p.data.id.includes(':') ? esc(petInfo(p.data.id).name) : itemLabel(p.data.id)} seharga <b>${V.n(price)} $LM</b>? Fee listing ${V.n(fee)} $LM dibayar sekarang.`, async (c) => {
          await game.marketList(p.data.id, price);
          await show(c, V.myListingsView(game.last));
        });
      }
      case 'fres': {
        const v = Math.round(Number(parseAmount(text)));
        store.setSetting('forgeReserveLm', v);
        return say(ctx, `✅ Cadangan forge: ${V.n(v)} $LM`);
      }
      case 'dep': {
        const amount = parseAmount(text);
        if (!(Number(amount) > 0)) throw new Error('Jumlah harus > 0.');
        const b = await game.walletBalances();
        if (ethers.parseUnits(amount, 18) > b.lm) throw new Error(`$LM on-chain tidak cukup (punya ${fmtUnits(b.lm)}).`);
        return confirm(ctx, `Deposit <b>${V.n(amount)} $LM</b> dari wallet bot ke game?`, async (c) => background(c, async () => {
          const m = await say(c, '⏳ Mengirim $LM ke treasury…');
          const edit = (t) => c.api.editMessageText(c.chat.id, m.message_id, t, HTML).catch(() => {});
          const r = await game.deposit(amount, (s, hash) => {
            if (s === 'tunggu') edit(`⏳ Menunggu konfirmasi ${txLink(hash)}…`);
            if (s === 'kredit') edit(`⏳ Menunggu game mengkredit ${txLink(hash)}…`);
          });
          store.addLog(`Deposit ${V.n(amount)} $LM (${r.hash})`, 'manual');
          await edit(`✅ Deposit ${V.n(amount)} $LM masuk ke game ${txLink(r.hash)}`);
        }));
      }
      case 'claim': {
        if (!/^0x[0-9a-fA-F]{64}$/.test(text)) throw new Error('Tx hash tidak valid.');
        await say(ctx, '⏳ Mengecek transaksi…');
        return background(ctx, async () => { await game.depositClaim(text); await say(ctx, '✅ Deposit dikredit ke saldo game.'); });
      }
      case 'wd': {
        const amount = Math.floor(Number(parseAmount(text)));
        return confirm(ctx, `Withdraw <b>${V.n(amount)} $LM</b> ke <code>${store.sessionAddress()}</code>? Saldo game langsung terpotong, dibayar setelah review.`, async (c) => {
          await game.withdraw(amount);
          store.addLog(`Withdraw ${V.n(amount)} $LM diajukan`, 'manual');
          await say(c, '✅ Permintaan withdraw terkirim. Cek statusnya di 💰 Wallet.');
        });
      }
      case 'sendTo': {
        if (!isAddress(text)) throw new Error('Alamat tidak valid.');
        return ask(ctx, 'sendAmt', `Ketik jumlah ${p.data.kind === 'eth' ? 'ETH' : '$LM'} yang dikirim ke <code>${ethers.getAddress(text)}</code>.`, { ...p.data, to: ethers.getAddress(text) });
      }
      case 'sendAmt': {
        const amount = parseAmount(text);
        const sym = p.data.kind === 'eth' ? 'ETH' : '$LM';
        const b = await game.walletBalances();
        const have = p.data.kind === 'eth' ? b.eth : b.lm;
        if (ethers.parseUnits(amount, 18) > have) throw new Error(`Saldo ${sym} tidak cukup.`);
        return confirm(ctx, `Kirim <b>${amount} ${sym}</b> ke <code>${p.data.to}</code>? Transaksi on-chain tidak bisa dibatalkan.`, async (c) => background(c, async () => {
          const tx = await game.send(p.data.kind, p.data.to, amount);
          const m = await say(c, `⏳ Terkirim, menunggu konfirmasi ${txLink(tx.hash)}…`);
          await game.wallet().wait(tx);
          store.addLog(`Kirim ${amount} ${sym} ke ${p.data.to} (${tx.hash})`, 'manual');
          await c.api.editMessageText(c.chat.id, m.message_id, `✅ ${amount} ${sym} terkirim ${txLink(tx.hash)}`, HTML).catch(() => {});
        }));
      }
      default: return undefined;
    }
  }));

  bot.catch((err) => console.error('[bot]', err.error?.message || err.message));

  bot.idle = () => Promise.allSettled([...tasks]);

  bot.notify = async (text) => {
    for (const id of cfg.ownerIds) await bot.api.sendMessage(id, text, HTML).catch((e) => console.error('[notify]', e.message));
  };
  return bot;
}
