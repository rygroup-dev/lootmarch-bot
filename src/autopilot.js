import { ApiError } from './api.js';
import { itemInfo, itemLabel, RARITY_RANK, ZONES_PER_FLOOR, sealCost, isPetId, petInfo, heroPower } from './catalog.js';
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

  await step('Live check', async () => {
    if (!s.alertLive) return;
    const lv = await game.live(0);
    const held = lv.held || 0;
    const bad = lv.needed && held > 0; // expired with nothing held is normal while offline
    const last = store.cursor('liveAlertAt');
    if (bad && now - last > H) {
      store.setCursor('liveAlertAt', now);
      const where = game.cfg?.desktopUrl ? `<a href="${game.cfg.desktopUrl}">layar game</a>` : 'game di browser';
      log.push(`🛡 <b>Live check</b> perlu dilewati${held ? `: ${fmt(held)} $LM tertahan` : ''}. Buka ${where} dan klik captcha-nya, $LM langsung cair.`);
    }
    if (!bad && last) store.setCursor('liveAlertAt', 0);
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

  await step('Salvage', async () => {
    if (!s.autoSalvage) return;
    const spare = Object.entries(st.items || {}).filter(([id, q]) => {
      const i = itemInfo(id);
      return i.kind === 'gear' && !i.plus && (RARITY_RANK[i.rarity] ?? 9) <= s.salvageLevel && q > 1;
    });
    if (!spare.length) return;
    const bone0 = st.balances?.Bone || 0;
    await game.salvage(s.salvageLevel);
    st = game.last || st;
    log.push(`♻️ Salvage gear cadangan: +${fmt((st.balances?.Bone || 0) - bone0)} Bone`);
  });

  await step('Attribute', async () => {
    if (!s.autoAttr || !st.character?.sp) return;
    const sp = st.character.sp;
    const next = await game.autoAttributes(s.build);
    st = game.last || st;
    if (next) log.push(`📈 ${sp} attribute point dipakai [${BUILDS[resolveBuild(s.build, st.character.classId)].name}] (STR ${next.str} · VIT ${next.vit} · AGI ${next.agi} · DEF ${next.def} · VAM ${next.vam})`);
  });

  // Seals come before forging: a new floor pays x1.5 $LM per room, forever.
  await step('Floor', async () => {
    const pr = st.progress || {};
    const unlocked = pr.floor_unlocked || 1;
    if ((pr.best_depth || 0) < unlocked * ZONES_PER_FLOOR) return; // floor not fully cleared yet
    const next = unlocked + 1;
    const cost = sealCost(next);
    const lm = st.balances?.LM || 0; const bone = st.balances?.Bone || 0;
    if (s.autoSeal && lm >= cost.lm && bone >= cost.bone) {
      await game.unlockFloor(next);
      st = game.last || st;
      log.push(`🔓 <b>Seal Floor ${next} dibuka!</b> (-${fmt(cost.lm)} $LM, -${fmt(cost.bone)} Bone). Musuh lebih kuat, hadiah ×1,5. Pindah lewat 🗺 Travel kalau hero sudah siap.`);
      return;
    }
    if (store.cursor('sealAlert') === next) return;
    store.setCursor('sealAlert', next);
    log.push(`🏁 Floor ${unlocked} sudah clear semua! Seal Floor ${next} butuh ${fmt(cost.lm)} $LM + ${fmt(cost.bone)} Bone (kamu: ${fmt(lm)} / ${fmt(bone)}).`);
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
    if (!s.autoDaily || now - store.cursor('dailyAt') < 0.5 * H) return;
    store.setCursor('dailyAt', now);
    const got = await game.claimDailyAll();
    if (got.length) log.push('📜 Quest diklaim: ' + got.join(', '));
  });

  await step('Pass', async () => {
    if (!s.autoPass || now - store.cursor('passAt') < H) return;
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
