import { ApiError } from './api.js';
import { itemInfo, itemLabel, RARITY_RANK, ZONES_PER_FLOOR, sealCost, isPetId, petInfo, heroPower, regionName } from './catalog.js';
import { BUILDS, resolveBuild } from './game.js';

const H = 3600 * 1000;
const fmt = (n) => Math.round(n || 0).toLocaleString('en-US');
const SLOT_ORDER = ['weapon', 'armor', 'helmet', 'shield', 'boots', 'ring', 'amulet'];

// One autopilot round. Each step is independent: a failure is logged and the
// round moves on, so one broken endpoint never stalls the rest.
export async function runRound(game, store, { now = Date.now() } = {}) {
  const s = store.settings;
  const log = [];
  const errors = [];
  const step = async (name, fn) => {
    try { await fn(); } catch (e) {
      if (e instanceof ApiError && e.status === 429) return; // rate limited, next round
      errors.push(`${name}: ${e.message}`);
    }
  };

  let st = await game.state();
  let newGear = 0;
  if (game.needsHero(st)) {
    if (!store.cursor('heroAlert')) { store.setCursor('heroAlert', 1); log.push('🆕 Akun ini belum punya hero. Tekan /start untuk pilih class & nama.'); }
    return { log, errors };
  }
  if (store.cursor('heroAlert')) store.setCursor('heroAlert', 0);

  // Track online play (rooms cleared today, deepest region) to spot an active
  // browser, report room/hour and notice a hero stuck at a boss.
  let prog = null;
  await step('Progress', async () => {
    const p = await game.cached('pass', 60000, () => game.pass());
    prog = recordProgress(store, { at: now, rooms: p.today?.rooms ?? 0, depth: st.progress?.best_depth ?? 0, zone: st.progress?.zone_index ?? 0, floor: st.progress?.floor ?? 1 });
  });

  await step('Live check', async () => {
    if (!s.alertLive) return;
    const lv = await game.live(0);
    const held = lv.held || 0;
    const left = (lv.expiresAt || 0) - now / 1000;
    const active = prog?.activeRecently; // a browser tab cleared rooms in the last 30 min
    const where = game.cfg?.desktopUrl ? `<a href="${game.cfg.desktopUrl}">layar game</a>` : 'game di browser';
    // While playing online, warn as soon as the check is due (the game asks 5 min early)
    // so the hero is not stalled; offline, only $LM actually held matters.
    const due = lv.needed && active && (!lv.valid || left < 6 * 60);
    const key = due ? 'exp:' + lv.expiresAt : held > 0 ? 'held' : '';
    if (due && store.cursor('liveAlertKey', '') !== key) {
      store.setCursor('liveAlertKey', key);
      log.push(`🛡 <b>Captcha live check ${lv.valid ? 'sebentar lagi muncul' : 'menunggu'}</b> — hero ${lv.valid ? 'akan' : 'sedang'} tertahan. Buka ${where} dan centang "Verify you are human".`);
    } else if (!due && held > 0 && now - store.cursor('liveAlertAt') > H) {
      store.setCursor('liveAlertAt', now);
      log.push(`🛡 <b>Live check</b>: ${fmt(held)} $LM tertahan. Buka ${where} dan klik captcha-nya, $LM langsung cair.`);
    }
    if (lv.valid && left > 6 * 60) store.setCursor('liveAlertKey', '');
  });

  await step('Stuck', async () => {
    if (!prog?.stuck) return;
    if (store.cursor('stuckDepth') === prog.depth) return;
    store.setCursor('stuckDepth', prog.depth);
    log.push(`🧱 <b>Hero mentok</b> di Floor ${prog.floor} · ${regionName(prog.zone)}: ${fmt(prog.stuckRooms)} room dalam ${Math.round(prog.stuckHours)} jam tanpa naik region (kemungkinan kalah di boss). Saran: 🛍 Upgrade dari Market, nyalakan 🔨 Auto forge, atau 🗺 Travel mundur 1 region untuk farming dulu.`);
  });

  await step('AFK', async () => {
    if (!s.autoAfk) return;
    const last = store.cursor('afkAt');
    if (last && now - last < s.afkHours * H) return;
    const pre = await game.afkPreview();
    store.setCursor('afkAt', now);
    if (!pre?.seconds || pre.seconds < 300) return;
    const res = await game.afkClaim();
    const r = res.rewards || pre.rewards || {};
    log.push(`💤 AFK ${Math.round(pre.seconds / 60)} mnt: +${fmt(r.lm)} $LM · +${fmt(r.xp)} XP · +${fmt(r.bone)} Bone${r.items?.length ? ` · ${r.items.length} item` : ''}`);
    st = game.last || st;
  });

  await step('Loot', async () => {
    if (!s.autoLoot) return;
    const p = st.pendingLoot || {};
    if (!(p.drops > 0 || p.bone > 0 || p.items?.length)) return;
    const res = await game.lootClaim();
    newGear = res.claimed?.items || 0;
    log.push(`🎁 Loot diklaim: +${fmt(res.claimed?.bone)} Bone${newGear ? ` · ${newGear} item` : ''}`);
    st = game.last || st;
  });

  await step('Chest', async () => {
    if (!s.autoChest) return;
    const got = [];
    for (const [id, qty] of Object.entries(st.items || {})) {
      if (!id.startsWith('chest_') || !(qty > 0)) continue;
      for (let i = 0; i < Math.min(qty, 10); i++) {
        const r = await game.openChest(id);
        got.push(...revealed(r));
        newGear++;
      }
    }
    for (const [type, qty] of Object.entries((game.last || st).petChests || {})) {
      for (let i = 0; i < Math.min(qty || 0, 10); i++) got.push(...revealed(await game.openPetChest(type)));
    }
    st = game.last || st;
    if (got.length) log.push('📦 Chest dibuka: ' + got.map((x) => (isPetId(x) ? '🐾 ' + petInfo(x).name : itemLabel(x, { short: true }))).join(', '));
  });

  await step('Equip best', async () => {
    if (!s.autoEquip) return;
    const sig = JSON.stringify(Object.keys(st.items || {}).sort());
    if (!newGear && store.cursor('equipSig', '') === sig) return;
    const before = JSON.stringify(st.equipped || {});
    await game.equipBest();
    st = game.last || st;
    store.setCursor('equipSig', JSON.stringify(Object.keys(st.items || {}).sort()));
    if (JSON.stringify(st.equipped || {}) !== before) log.push('🧥 Equip best: gear terbaik dipasang.');
  });

  await step('Upgrade', async () => {
    if (!s.autoUpgrade || now - store.cursor('upgAt') < 0.5 * H) return;
    store.setCursor('upgAt', now);
    const budget = Math.floor((st.balances?.LM || 0) * s.upgradeShare);
    if (budget < 20) return;
    const plan = await game.upgradePlan(budget);
    if (!plan.picks.length) return;
    const { done } = await game.buyUpgrades(plan.picks);
    st = game.last || st;
    if (done.length) log.push(`🛍 Upgrade market: ${done.map((p) => itemLabel(p.listing.itemId, { short: true })).join(', ')} (−${fmt(done.reduce((t, p) => t + p.cost, 0))} $LM, ⚡ ${fmt(plan.base)} → ${fmt(heroPower(st))})`);
  });

  // Spare gear (the backpack only holds what is not worn, after Equip best):
  // common/uncommon -> Bone (30/80 Bone beat their ~80/~440 $LM market price and
  // Bone pays for seals & forging); rare and better -> listed on the market.
  await step('Salvage', async () => {
    if (!s.autoSalvage) return;
    const spare = Object.entries(st.items || {}).filter(([id, q]) => q > 0 && itemInfo(id).kind === 'gear' && (RARITY_RANK[itemInfo(id).rarity] ?? 9) <= s.salvageLevel);
    if (!spare.length) return;
    const bone0 = st.balances?.Bone || 0;
    let quickErr = null;
    if (spare.some(([id]) => !itemInfo(id).plus)) {
      // the game's Quick Salvage sends the rarity name ("common" / "uncommon" / "rare")
      try { await game.salvage(SALVAGE_LEVELS[s.salvageLevel] || 'common', 0); } catch (e) { quickErr = e; }
    }
    for (const [id, q] of spare) if (itemInfo(id).plus) for (let i = 0; i < Math.min(q, 5); i++) await game.salvageOne(id);
    st = game.last || st;
    const got = (st.balances?.Bone || 0) - bone0;
    if (got > 0) log.push(`♻️ Salvage ${spare.length} gear sisa: +${fmt(got)} Bone`);
    if (quickErr) throw quickErr;
  });

  // Market: report what sold since last round, then list spare gear above
  // salvageLevel (rarest first). One of the 5 slots is kept for rare+ gear;
  // an uncommon that finds no slot is salvaged instead of piling up.
  await step('Sell', async () => {
    const mine = st.market || [];
    const prev = store.cursor('myListings', {});
    const cancelled = store.cursor('cancelledListings', []);
    const gone = Object.entries(prev).filter(([id]) => !mine.some((l) => l.id === id) && !cancelled.includes(id));
    if (gone.length) log.push('💰 <b>Terjual</b>: ' + gone.map(([, l]) => `${itemLabel(l.itemId, { short: true })} → +${fmt(l.price)} $LM`).join(', '));
    const snapshot = () => store.setCursor('myListings', Object.fromEntries((st.market || []).map((l) => [l.id, { itemId: l.itemId, price: l.price }])));
    snapshot();
    if (cancelled.length) store.setCursor('cancelledListings', []);

    if (!s.autoSell) return;
    const spare = Object.entries(st.items || {})
      .filter(([id, q]) => q > 0 && itemInfo(id).kind === 'gear' && (RARITY_RANK[itemInfo(id).rarity] ?? 0) > s.salvageLevel)
      .sort((x, y) => (RARITY_RANK[itemInfo(y[0]).rarity] ?? 0) - (RARITY_RANK[itemInfo(x[0]).rarity] ?? 0));
    if (!spare.length) return;
    const { listings } = await game.cached('market:all', 30000, () => game.market({}));
    const listed = []; const salvaged = [];
    for (const [id, q] of spare) {
      const free = 5 - (st.market || []).length;
      const rareUp = (RARITY_RANK[itemInfo(id).rarity] ?? 0) >= RARITY_RANK.rare;
      const price = sellPrice(id, listings);
      if (price && (rareUp ? free > 0 : free > 1)) {
        await game.marketList(id, price);
        st = game.last || st;
        listed.push(`${itemLabel(id, { short: true })} @ ${fmt(price)}`);
      } else if (!rareUp && s.autoSalvage) {
        for (let i = 0; i < Math.min(q, 5); i++) await game.salvageOne(id);
        st = game.last || st;
        salvaged.push(itemLabel(id, { short: true }));
      }
    }
    snapshot();
    if (listed.length) log.push(`🏷 Dijual di market: ${listed.join(', ')}`);
    if (salvaged.length) log.push(`♻️ Slot market penuh, di-salvage: ${salvaged.join(', ')}`);
  });

  await step('Attribute', async () => {
    if (!s.autoAttr || !st.character?.sp) return;
    const sp = st.character.sp;
    const next = await game.autoAttributes(s.build);
    st = game.last || st;
    if (next) log.push(`📈 ${sp} attribute point dipakai [${BUILDS[resolveBuild(s.build, st.character.classId)].name}] (STR ${next.str} · VIT ${next.vit} · AGI ${next.agi} · DEF ${next.def} · VAM ${next.vam})`);
  });

  // Seals come before forging: a new floor pays x1.5 $LM per room, forever.
  // Floors: when the last boss of a floor falls and the next floor is still
  // sealed, the server sets floor_gate = next floor and the hero stops there.
  // Break the seal, then travel the hero through (the web client only walks on
  // by itself when the next floor was already open).
  await step('Floor', async () => {
    let pr = st.progress || {};
    const unlocked = pr.floor_unlocked || 1;
    const next = unlocked + 1;
    const atGate = pr.floor_gate === next || (pr.best_depth || 0) >= unlocked * ZONES_PER_FLOOR;
    if (atGate) {
      const cost = sealCost(next);
      const lm = st.balances?.LM || 0; const bone = st.balances?.Bone || 0;
      if (s.autoSeal && lm >= cost.lm && bone >= cost.bone) {
        await game.unlockFloor(next);
        st = game.last || st; pr = st.progress || pr;
        log.push(`🔓 <b>Seal Floor ${next} dibuka!</b> (−${fmt(cost.lm)} $LM, −${fmt(cost.bone)} Bone). Musuh lebih kuat, hadiah ×1,5.`);
      } else if (store.cursor('sealAlert') !== next) {
        store.setCursor('sealAlert', next);
        log.push(`🏁 Floor ${unlocked} sudah clear semua! Seal Floor ${next} butuh ${fmt(cost.lm)} $LM + ${fmt(cost.bone)} Bone (kamu: ${fmt(lm)} / ${fmt(bone)}).`);
        return;
      }
    }
    // hero parked on the last region of a floor whose next floor is open: move on
    const lastZone = (pr.zone_index ?? 0) >= ZONES_PER_FLOOR - 1;
    if (s.autoTravel && lastZone && (pr.floor_unlocked || 1) > (pr.floor || 1)) {
      const wait = game.travelReadyIn(st);
      if (wait > 0) return;
      const to = (pr.floor || 1) + 1;
      await game.travel(to, 0);
      st = game.last || st;
      log.push(`🧭 Travel ke <b>Floor ${to}</b> · ${regionName(0)}. Hero lanjut menjelajah floor baru.`);
    }
  });

  await step('Forge', async () => {
    if (!s.autoForge) return;
    let done = 0;
    for (let i = 0; i < 5; i++) {
      const lm = st.balances?.LM || 0;
      const bone = st.balances?.Bone || 0;
      if (lm <= s.forgeReserveLm || bone <= s.forgeReserveBone) break;
      const target = forgeTarget(st.equipped || {});
      if (!target) break;
      try { await game.forge(target, 1); } catch { break; } // usually: not enough materials
      const after = game.last || st;
      if ((after.balances?.LM || 0) < s.forgeReserveLm || (after.balances?.Bone || 0) < s.forgeReserveBone) { st = after; done++; break; }
      st = after; done++;
    }
    if (done) log.push(`🔨 Forge ${done}× (gear terpasang dengan level + paling rendah).`);
  });

  await step('Quest', async () => {
    if (!s.autoDaily || now - store.cursor('dailyAt') < 0.25 * H) return;
    store.setCursor('dailyAt', now);
    const got = await game.claimDailyAll();
    if (got.length) log.push('📜 Quest diklaim: ' + got.join(', '));
  });

  // Daily nudge for "Share your run" (5,000 $LM). Posting stays a human tap.
  await step('Share', async () => {
    if (!s.alertShare) return;
    const d = await game.cached('daily', 60000, () => game.daily());
    const cm = d.community || {};
    const open = (cm.status || 'NOT_SUBMITTED') === 'NOT_SUBMITTED' || (cm.status === 'REJECTED' && cm.resubmissionAllowed);
    const key = `${d.dayKey}:${cm.status}`;
    if (open && store.cursor('shareNudge', '') !== key) {
      store.setCursor('shareNudge', key);
      log.push(cm.xUsername
        ? '🐦 <b>Share your run</b> hari ini belum dikirim: +5.000 $LM. Buka 📜 Quest → 🐦 Share di X (2 tap).'
        : '🐦 <b>Share your run</b> = +5.000 $LM per hari. Hubungkan X dulu: 📜 Quest → 🐦 Share di X → 🔗 Hubungkan X.');
    }
    const seen = store.cursor('shareSeen', '');
    if (cm.status === 'APPROVED' && seen !== `${d.dayKey}:APPROVED`) {
      store.setCursor('shareSeen', `${d.dayKey}:APPROVED`);
      log.push('🐦 Post X disetujui: <b>+5.000 $LM</b> 🎉');
    } else if (cm.status === 'REJECTED' && seen !== `${d.dayKey}:REJECTED`) {
      store.setCursor('shareSeen', `${d.dayKey}:REJECTED`);
      log.push(`🐦 Post X ditolak${cm.reviewReason ? ': ' + cm.reviewReason : ''}.${cm.resubmissionAllowed ? ' Boleh kirim ulang.' : ' Coba lagi besok.'}`);
    }
  });

  await step('Pass', async () => {
    if (!s.autoPass || now - store.cursor('passAt') < 0.5 * H) return;
    store.setCursor('passAt', now);
    const { pass: p, claimed } = await game.claimPassIfAny();
    if (claimed) log.push('🎫 Hadiah March Pass diklaim.');
    // Premium can be bought late: reached tiers pay out at once. Remind when it is time.
    const sid = p.season?.id;
    const endsIn = (p.season?.end || 0) - now / 1000;
    if (!p.premium && p.season?.active && store.cursor('passRemind') !== sid && (p.tier >= p.maxTier || endsIn < 3 * 86400)) {
      store.setCursor('passRemind', sid);
      log.push(`♛ <b>Waktunya beli Pass Premium!</b> Tier ${p.tier}/${p.maxTier}, season berakhir ${Math.max(0, Math.round(endsIn / 3600))} jam lagi. Semua tier premium langsung cair begitu dibeli (🎫 Pass → ♛ Beli).`);
    }
  });

  return { log, errors };
}

// Keep ~6 h of 5-minute samples. Rooms are "cleared today" and reset at 00:00 UTC.
export function recordProgress(store, sample) {
  const list = (store.data.samples ||= []);
  const last = list[list.length - 1];
  if (last && sample.rooms < last.rooms) for (const x of list) x.rooms -= last.rooms; // new day: rebase
  list.push(sample);
  while (list.length && sample.at - list[0].at > 6 * H) list.shift();
  store.save();
  return progressStats(list, sample.at);
}

export function progressStats(list, now = Date.now()) {
  const cur = list[list.length - 1];
  if (!cur) return null;
  const since = (ms) => list.find((x) => now - x.at <= ms) || cur;
  const h1 = since(H); const m30 = since(H / 2);
  const roomsPerHour = cur.at > h1.at ? ((cur.rooms - h1.rooms) * H) / (cur.at - h1.at) : 0;
  // stuck: 3 h+ of steady clearing (≥ 120 rooms) without a deeper region
  const old = list.find((x) => now - x.at >= 3 * H && now - x.at <= 3.5 * H) || (now - list[0].at >= 3 * H ? list[0] : null);
  const stuckRooms = old ? cur.rooms - old.rooms : 0;
  return {
    ...cur,
    roomsPerHour,
    activeRecently: cur.rooms > m30.rooms,
    stuck: !!old && old.depth === cur.depth && stuckRooms >= 120,
    stuckRooms, stuckHours: old ? (now - old.at) / H : 0,
  };
}

// Just under the cheapest listing of the same item (same + level), else of the
// same base item; never below what salvaging it would give.
export const SALVAGE_LEVELS = ['common', 'uncommon', 'rare'];
const SALVAGE_BONE = { common: 30, uncommon: 80, rare: 200, epic: 500, legendary: 1200, mythic: 3000 };
export function sellPrice(id, listings, boneLm = 4.4) {
  const info = itemInfo(id);
  const same = listings.filter((l) => l.itemId === id).map((l) => l.price);
  const base = listings.filter((l) => itemInfo(l.itemId).baseId === info.baseId).map((l) => l.price);
  const ref = same.length ? Math.min(...same) : base.length ? Math.min(...base) : 0;
  if (!ref) return 0;
  const floor = Math.ceil((SALVAGE_BONE[info.rarity] || 30) * boneLm * 1.1);
  return Math.max(floor, ref - 1);
}

// Pull item / pet ids out of a chest-open response, whatever shape it has.
export function revealed(r) {
  const raw = r?.items ?? r?.drops ?? r?.rewards?.items ?? r?.item ?? r?.itemId ?? r?.pet ?? r?.petId ?? [];
  return (Array.isArray(raw) ? raw : [raw]).map((x) => (typeof x === 'string' ? x : x?.itemId || x?.petId || x?.id)).filter(Boolean);
}

// Cheapest upgrade first: equipped item with the lowest + level, weapon wins ties.
export function forgeTarget(equipped) {
  let best = null;
  for (const slot of SLOT_ORDER) {
    const id = equipped[slot];
    if (!id) continue;
    const info = itemInfo(id);
    if (info.kind !== 'gear' || info.plus >= 60) continue;
    if (!best || info.plus < best.plus) best = { id, plus: info.plus };
  }
  return best?.id || null;
}

export function startAutopilot({ game, store, notify, tickSeconds, feedSeconds }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (!(await game.ensureSession())) return;
      const { log, errors } = await runRound(game, store);
      store.setCursor('lastRun', Date.now());
      for (const l of log) store.addLog(l.replace(/<[^>]+>/g, ''));
      for (const e of errors) store.addLog('⚠️ ' + e);
      const errKey = errors.join('|');
      if (errors.length && errKey !== store.cursor('lastErr', '')) {
        store.setCursor('lastErr', errKey);
        await notify('⚠️ <b>Autopilot</b>\n' + errors.map((e) => '• ' + esc(e)).join('\n'));
      } else if (!errors.length && store.cursor('lastErr', '')) store.setCursor('lastErr', '');
      if (log.length && store.settings.reports) await notify('🤖 <b>Autopilot</b>\n' + log.join('\n'));
    } catch (e) {
      const k = 'fatal:' + e.message;
      if (k !== store.cursor('lastErr', '')) { store.setCursor('lastErr', k); await notify('⚠️ ' + esc(e.message)); }
    } finally { running = false; }
  };

  const feed = async () => {
    try {
      const after = store.cursor('feedId');
      const f = await game.api.feed(after);
      if (f.online != null) game.cache.set('feed', { at: Date.now(), p: Promise.resolve(f) });
      if (!after) { store.setCursor('feedId', f.last || 0); return; }
      const mine = game.last?.character?.appearance?.nick;
      for (const ev of f.events || []) {
        const own = mine && ev.name === mine;
        if (!own && !store.settings.alertDrops) continue;
        if (ev.itemId) {
          const who = own ? '🎉 <b>Drop kamu!</b>' : `📣 ${esc(ev.name)}`;
          await notify(`${who} ${esc(itemInfo(ev.itemId).name)} (${ev.rarity}) dari ${ev.source || 'drop'}`);
        }
      }
      if (f.last) store.setCursor('feedId', f.last);
    } catch { /* feed is best effort */ }
  };

  const t1 = setInterval(tick, tickSeconds * 1000);
  const t2 = setInterval(feed, feedSeconds * 1000);
  setTimeout(tick, 5000);
  return { tick, stop: () => { clearInterval(t1); clearInterval(t2); } };
}

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
