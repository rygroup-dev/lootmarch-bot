import { ApiError } from './api.js';
import { CAT, FORGE_GROWTH, itemInfo, itemLabel, RARITY_RANK, ZONES_PER_FLOOR, sealCost, isPetId, petInfo, petProgress, heroPower, regionName } from './catalog.js';
import { BUILDS, resolveBuild, planEquip } from './game.js';

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

  // The dungeon needs a minimum $LM in the wallet (server: /game/hold). Below it the game blocks play.
  await step('Hold', async () => {
    const h = await game.hold();
    if (!h?.required) return;
    if (!h.ok) {
      if (store.cursor('holdAlert') !== h.checkedAt) {
        store.setCursor('holdAlert', h.checkedAt);
        log.push(`🔐 <b>Hold kurang!</b> Wallet memegang ${fmt(h.holds)} $LM, game mewajibkan ${fmt(h.required)} $LM untuk masuk dungeon. Isi wallet dulu, hero tidak bisa main.`);
      }
    } else if (store.cursor('holdAlert')) store.setCursor('holdAlert', 0);
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

  // The game tab stopped clearing rooms (wallet popup locked, captcha, crash…).
  await step('Stalled', async () => {
    if (!prog) return;
    if (!prog.stalled) { if (prog.activeRecently) store.setCursor('stallAlert', 0); return; }
    if (store.cursor('stallAlert')) return;
    store.setCursor('stallAlert', now);
    const where = game.cfg?.desktopUrl ? `<a href="${game.cfg.desktopUrl}">layar game</a>` : 'game di browser';
    log.push(`⛔ <b>Game berhenti</b>: tidak ada room 20 menit terakhir. Buka ${where} dan cek: wallet terkunci (unlock), captcha, atau tombol yang menunggu diklik.`);
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

  // Equip by policy (highest rarity first, then Power) instead of the server's
  // "Equip best", which prefers a +17 rare over a fresh epic that will outgrow it.
  await step('Equip', async () => {
    if (!s.autoEquip) return;
    const picks = planEquip(st);
    const done = [];
    for (const id of picks) {
      await game.equip(id);
      st = game.last || st;
      done.push(itemLabel(id, { short: true }));
    }
    if (done.length) log.push(`🧥 Dipakai: ${done.join(', ')}`);
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

    // Stale listings (24 h unsold): pull them and salvage for Bone, any rarity.
    // Mostly +0 copies sell; what has not moved in a day is unlikely to.
    const nowSec = now / 1000;
    for (const l of st.market || []) {
      if (!l.at || nowSec - l.at < 24 * 3600 || isPetId(l.itemId)) continue;
      await game.marketCancel(l.id);
      store.setCursor('cancelledListings', [...store.cursor('cancelledListings', []), l.id]);
      await game.salvageOne(l.itemId);
      st = game.last || st;
      log.push(`♻️ Tidak laku 24 jam, ditarik & di-salvage: ${itemLabel(l.itemId, { short: true })}`);
    }
    snapshot();

    const spare = Object.entries(st.items || {})
      .filter(([id, q]) => q > 0 && itemInfo(id).kind === 'gear' && (RARITY_RANK[itemInfo(id).rarity] ?? 0) > s.salvageLevel)
      .sort((x, y) => (RARITY_RANK[itemInfo(y[0]).rarity] ?? 0) - (RARITY_RANK[itemInfo(x[0]).rarity] ?? 0));
    if (!spare.length) return;
    const [{ listings }, hist] = await Promise.all([
      game.cached('market:all', 30000, () => game.market({})),
      game.cached('market:hist', 5 * 60000, () => game.marketHistory()).catch(() => ({ recent: [] })),
    ]);
    const sales = hist.recent || [];
    const listed = []; const salvaged = [];
    for (const [id, q] of spare) {
      const free = 5 - (st.market || []).length;
      const rareUp = (RARITY_RANK[itemInfo(id).rarity] ?? 0) >= RARITY_RANK.rare;
      const quote = sellQuote(id, listings, sales);
      const price = quote.price;
      if (price && (rareUp ? free > 0 : free > 1)) {
        await game.marketList(id, price);
        st = game.last || st;
        const why = [quote.cheapest && `termurah ${fmt(quote.cheapest)}`, quote.lastSold && `laku terakhir ${fmt(quote.lastSold)}`, price === quote.floor && 'batas salvage'].filter(Boolean).join(' · ');
        listed.push(`${itemLabel(id, { short: true })} @ ${fmt(price)}${why ? ` (${why})` : ''}`);
      } else if (!rareUp && s.autoSalvage) {
        const n = Math.min(Number(q) || 0, 5);
        for (let i = 0; i < n; i++) await game.salvageOne(id);
        st = game.last || st;
        if (n) salvaged.push(itemLabel(id, { short: true }));
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
    // Bone is cheap in the shop (a pack is priced in $, ~2 $LM per Bone at times): top it up for forging.
    const pack = st.prices?.bonePack;
    const want = s.forgeReserveBone + 2000;
    if (s.autoBuyBone && pack?.lm && (st.balances?.Bone || 0) < s.forgeReserveBone + 500 && forgeTarget(st.equipped || {}, forgeFloor(st.equipped || {}))) {
      const packs = Math.min(15, Math.ceil((want - (st.balances?.Bone || 0)) / pack.bone));
      const cost = packs * pack.lm;
      if (packs > 0 && (st.balances?.LM || 0) - cost > s.forgeReserveLm + 2000) {
        await game.buyBone(packs);
        st = game.last || st;
        log.push(`🦴 Beli ${packs} Bone pack (+${fmt(packs * pack.bone)} Bone, −${fmt(cost)} $LM) untuk forge.`);
      }
    }
    let done = 0;
    // The server answers each forge with its cost; the next step (same or a bit
    // more) must fit above the reserves, so they are never crossed.
    let last = store.cursor('forgeCost', { lm: 60, bone: 50 });
    for (let i = 0; i < 20; i++) {
      const lm = st.balances?.LM || 0;
      const bone = st.balances?.Bone || 0;
      if (lm - last.lm * 1.25 < s.forgeReserveLm || bone - last.bone * 1.25 < s.forgeReserveBone) break;
      const target = forgeTarget(st.equipped || {}, forgeFloor(st.equipped || {}));
      if (!target) break;
      // the first failure is reported; later ones just mean materials ran out
      let res;
      try { res = await game.forge(target, 1); } catch (e) {
        if (/not enough|insufficient/i.test(e.message)) break; // out of Bone/$LM: normal, wait for more
        if (!done) throw e;
        break;
      }
      if (res?.cost) { last = { lm: res.cost.lm || last.lm, bone: res.cost.bone || last.bone }; store.setCursor('forgeCost', last); }
      st = game.last || st; done++;
    }
    if (done) log.push(`🔨 Forge ${done}×: ${Object.values(st.equipped || {}).filter((id) => itemInfo(id).plus && (RARITY_RANK[itemInfo(id).rarity] ?? 0) >= forgeFloor(st.equipped || {})).map((id) => itemLabel(id, { short: true })).join(', ')}`);
  });

  // Pets: only epic or better are levelled (Bone + 1 $LM per Bone), up to the next level per round.
  await step('Pet', async () => {
    if (!s.autoFeedPet) return;
    const id = st.pets?.activePet;
    if (!id || (RARITY_RANK[petInfo(id).rarity] ?? 0) < RARITY_RANK.epic) return;
    const own = (st.pets.owned || []).find((p) => p.petId === id);
    const pg = petProgress(own?.xp || 0);
    if (pg.max) return;
    const bone = Math.min(pg.boneToNext, (st.balances?.Bone || 0) - s.forgeReserveBone, (st.balances?.LM || 0) - s.forgeReserveLm);
    if (bone < 50) return;
    await game.feedPet(id, Math.floor(bone));
    st = game.last || st;
    log.push(`🐾 ${petInfo(id).name} diberi ${fmt(bone)} Bone → Lv ${petProgress(((st.pets.owned || []).find((p) => p.petId === id) || {}).xp || 0).level}`);
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
  // stalled: the browser was clearing rooms in the last 6 h but nothing for 20 min
  const m20 = since(H / 3);
  const h6 = list.find((x) => now - x.at <= 6 * H) || cur;
  const stalled = cur.at - m20.at >= 15 * 60e3 && cur.rooms === m20.rooms && m20.rooms > h6.rooms;
  return {
    ...cur,
    roomsPerHour,
    activeRecently: cur.rooms > m30.rooms,
    stuck: !!old && old.depth === cur.depth && stuckRooms >= 120,
    stalled,
    stuckRooms, stuckHours: old ? (now - old.at) / H : 0,
  };
}

// Just under the cheapest listing of the same item (same + level), else of the
// same base item; never below what salvaging it would give.
export const SALVAGE_LEVELS = ['common', 'uncommon', 'rare'];
const SALVAGE_BONE = { common: 30, uncommon: 80, rare: 200, epic: 500, legendary: 1200, mythic: 3000 };
// Price a spare for a quick sale without giving it away:
//  - references: live listings AND recent sales of the same item (same + level);
//    if there are none, the closest + level of the same item scaled by forge growth
//  - bait prices under half the going rate are ignored
//  - one under the cheapest believable listing, never under salvage value
export function sellQuote(id, listings, sales = [], boneLm = 4.4) {
  const info = itemInfo(id);
  const g = FORGE_GROWTH[info.rarity] ?? 0.05;
  const scaleTo = (price, plus) => Math.round(price * (1 + g * info.plus) / (1 + g * plus));
  const median = (a) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : 0; };
  let live = listings.filter((l) => l.itemId === id).map((l) => l.price).sort((x, y) => x - y);
  let sold = sales.filter((l) => l.itemId === id).map((l) => l.price);
  if (!live.length && !sold.length) { // nothing at our + level: borrow the nearest + level
    const near = (arr) => {
      const c = arr.map((l) => ({ p: l.price, i: itemInfo(l.itemId) })).filter((x) => x.i.baseId === info.baseId);
      if (!c.length) return [];
      const d = Math.min(...c.map((x) => Math.abs(x.i.plus - info.plus)));
      return c.filter((x) => Math.abs(x.i.plus - info.plus) === d).map((x) => scaleTo(x.p, x.i.plus));
    };
    live = near(listings).sort((x, y) => x - y); sold = near(sales);
  }
  const lastSold = median(sold);
  // bait: far under the next listing AND under real sales; sky-high asks never set the rate
  while (live.length > 1 && live[0] < live[1] * 0.5 && (!sold.length || live[0] < lastSold * 0.5)) live.shift();
  const cheapest = live[0] || 0;
  let ref = cheapest || lastSold;
  if (cheapest && lastSold && cheapest < lastSold * 0.5) ref = lastSold; // lone bait listing
  const floor = Math.ceil((SALVAGE_BONE[info.rarity] || 30) * boneLm * 1.1);
  const price = ref ? Math.max(floor, ref - 1) : 0;
  return { price, cheapest, lastSold, floor };
}
export const sellPrice = (id, listings, sales = [], boneLm) => sellQuote(id, listings, sales, boneLm).price;

// Pull item / pet ids out of a chest-open response, whatever shape it has.
export function revealed(r) {
  const raw = r?.items ?? r?.drops ?? r?.rewards?.items ?? r?.item ?? r?.itemId ?? r?.pet ?? r?.petId ?? [];
  return (Array.isArray(raw) ? raw : [raw]).map((x) => (typeof x === 'string' ? x : x?.itemId || x?.petId || x?.id)).filter(Boolean);
}

// Cheapest upgrade first: equipped item with the lowest + level, weapon wins ties.
// Forge only keeper gear: epic or better, or legendary+ once every slot is legendary+.
export function forgeFloor(equipped) {
  const ranks = CAT.slots.map((sl) => (equipped[sl] ? RARITY_RANK[itemInfo(equipped[sl]).rarity] ?? 0 : -1));
  return ranks.every((r) => r >= RARITY_RANK.legendary) ? RARITY_RANK.legendary : RARITY_RANK.epic;
}

export function forgeTarget(equipped, minRank = 0) {
  let best = null;
  for (const slot of SLOT_ORDER) {
    const id = equipped[slot];
    if (!id) continue;
    const info = itemInfo(id);
    if (info.kind !== 'gear' || info.plus >= 60 || (RARITY_RANK[info.rarity] ?? 0) < minRank) continue;
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
