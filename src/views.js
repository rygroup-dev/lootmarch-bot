import { InlineKeyboard } from 'grammy';
import {
  CAT, RARITY_ICON, SLOT_ICON, SLOT_NAME, CLASS_ICON, itemInfo, itemLabel, itemStats, fmtStat, regionName,
  xpToNext, sealCost, SHOP_CHESTS, PET_CHESTS, petInfo, petProgress, petBonus, PET_ABILITY, ZONES_PER_FLOOR,
  heroPower, heroStats, PET_PREFIX, CLASS_INFO, NICK_MAX,
} from './catalog.js';
import { BUILDS, VAM_CAP, depth, resolveBuild } from './game.js';
import { esc } from './autopilot.js';

export const n = (v) => Math.round(Number(v) || 0).toLocaleString('en-US');
export const usd = (lm, st) => {
  const p = st?.prices?.lmUsd;
  if (!p) return '';
  const v = lm * p;
  return ` (≈ $${v >= 100 ? n(v) : v.toFixed(v >= 1 ? 2 : 4)})`;
};
export const dur = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}j ${m}m` : m ? `${m}m` : `${sec}d`;
};
const back = (kb, to = 'home') => kb.row().text('⬅️ Kembali', 'nav:' + to);
const ON = (b) => (b ? '✅' : '▫️');

// ---------------------------------------------------------------- home
const ago = (ms) => (ms ? dur((Date.now() - ms) / 1000) + ' lalu' : 'belum');

export function homeView(st, { live, online, autopilot, daily, pass, lastRun, nextAfkIn, travelIn, settings, desktopUrl, prog } = {}) {
  const c = st.character || {};
  const pr = st.progress || {};
  const b = st.balances || {};
  const nick = c.appearance?.nick || 'Hero';
  const next = xpToNext(c.level);
  const pend = st.pendingLoot || {};
  const eq = Object.values(st.equipped || {}).filter(Boolean).length;
  const chests = Object.entries(st.items || {}).filter(([k, v]) => k.startsWith('chest_') && v > 0).reduce((t, [, v]) => t + v, 0)
    + Object.values(st.petChests || {}).reduce((t, v) => t + (v || 0), 0);
  const lines = [
    `⚔️ <b>LootMarch</b> · <b>${esc(nick)}</b>`,
    '━━━━━━━━━━━━━━━━━━',
    `${CLASS_ICON[c.classId] || '🧝'} <b>${esc(c.className || c.classId || '-')}</b> Lv <b>${c.level ?? '?'}</b> · ${n(c.xp)}/${next ? n(next) : '?'} XP${c.sp ? ` · 📈 ${c.sp} SP` : ''}`,
    `⚡ Power <b>${n(heroPower(st))}</b> · 🧥 gear ${eq}/7 · 🐾 ${st.pets?.activePet ? esc(petInfo(st.pets.activePet).name) : '—'}`,
    `🗺 Floor <b>${pr.floor ?? 1}</b> · ${esc(regionName(pr.zone_index ?? 0))} (${(pr.zone_index ?? 0) + 1}/${ZONES_PER_FLOOR}) · terdalam ${pr.best_depth ?? 0}`,
    '',
    `💰 <b>${n(b.LM)}</b> $LM${usd(b.LM, st)}`,
    `🦴 ${n(b.Bone)} Bone${chests ? ` · 📦 ${chests} chest` : ''}${pend.drops || pend.bone ? ` · 🎁 ${n(pend.drops)} drop menunggu` : ''}`,
  ];
  if (daily) {
    const ms = daily.missions || [];
    const done = ms.filter((m) => m.claimed).length;
    const ready = ms.filter((m) => m.complete && !m.claimed).length;
    lines.push(`📜 Quest ${done}/${ms.length} diklaim${ready ? ` · 🎁 ${ready} siap` : ''} · daily ${daily.board?.claimed ? '✅' : `${daily.board?.completed ?? 0}/${daily.board?.required ?? 4}`} · login ${daily.login?.claimedToday ? '✅' : '🎁'}`);
  }
  if (pass) lines.push(`🎫 Pass tier <b>${pass.tier}</b>/${pass.maxTier} · ${n(pass.xp - pass.tier * pass.tierXp)}/${n(pass.tierXp)} XP${pass.premium ? ' · ♛' : ''}${pass.claimable ? ' · 🎁 siap klaim' : ''}`);
  if (live) {
    if (!live.needed) lines.push('🛡 Live check: tidak diperlukan');
    else if (live.held > 0) lines.push(`🛡 Live check: ⚠️ <b>${n(live.held)} $LM tertahan</b> — buka game di browser sebentar`);
    else if (live.valid) lines.push(`🛡 Live check: ✅ aktif ${dur(live.expiresAt - Date.now() / 1000)} lagi`);
    else lines.push('🛡 Live check: 💤 kedaluwarsa (normal saat offline)');
  }
  if (prog) lines.push(prog.activeRecently ? `⚔️ Online: <b>${n(prog.roomsPerHour)}</b> room/jam${prog.stuck ? ' · 🧱 mentok di boss' : ''}` : '⚔️ Online: 💤 tidak ada room 30 menit terakhir');
  lines.push('━━━━━━━━━━━━━━━━━━');
  const ap = [`🤖 Autopilot ${autopilot ? 'ON' : 'OFF'} · jalan ${ago(lastRun)}`];
  if (settings?.autoAfk && nextAfkIn != null) ap.push(`💤 AFK ${nextAfkIn > 0 ? 'diklaim ' + dur(nextAfkIn) + ' lagi' : 'segera'}`);
  lines.push(ap.join(' · '));
  lines.push(`🧭 Travel ${travelIn ? dur(travelIn) + ' lagi' : 'siap'}${online ? ` · 👥 ${n(online)} online` : ''}`);
  const kb = new InlineKeyboard()
    .text('🧝 Hero', 'nav:hero').text('🎒 Inventory', 'nav:inv:0').text('🎁 Loot & AFK', 'nav:loot').row()
    .text('📜 Quest', 'nav:quest').text('🎫 Pass', 'nav:pass').text('🗺 Travel', 'nav:travel').row()
    .text('🐾 Pet', 'nav:pet').text('🛒 Shop', 'nav:shop').text('🏪 Market', 'nav:mk:all:all:0').row()
    .text('💰 Wallet', 'nav:wallet').text('📖 Codex', 'nav:codex').text('🏆 Ranks', 'nav:ranks').row()
    .text('🤖 Jalankan autopilot', 'auto:run').text('📋 Log', 'nav:log').row()
    .text('⚙️ Setelan', 'nav:set').text('🔄 Refresh', 'nav:refresh');
  if (desktopUrl) kb.row().url('🖥 Buka layar game (VPS)', desktopUrl);
  return { text: lines.join('\n'), kb };
}

export function logView(entries) {
  const lines = ['📋 <b>Log aktivitas</b> (terbaru di atas)', ''];
  if (!entries.length) lines.push('Belum ada aktivitas. Autopilot mencatat semua yang dikerjakan di sini.');
  const fmtT = (ms) => new Date(ms).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  let used = 60;
  for (const e of entries) {
    const line = `<code>${fmtT(e.at)}</code> ${e.source === 'manual' ? '👆' : '🤖'} ${esc(e.text)}`;
    if (used + line.length > 3800) break;
    used += line.length + 1;
    lines.push(line);
  }
  const kb = new InlineKeyboard().text('🔄 Refresh', 'nav:log').text('🤖 Jalankan sekarang', 'auto:run');
  return { text: lines.join('\n'), kb: back(kb) };
}

// ---------------------------------------------------------------- hero
const ATTR_INFO = [
  ['str', '💪 STR', '+2 DMG'], ['vit', '❤️ VIT', '+8 HP'], ['agi', '💨 AGI', '+2 SPD, +1% dodge'],
  ['def', '🛡 DEF', '+1% block'], ['vam', '🩸 VAM', `+0.25% life steal (maks ${VAM_CAP})`],
];

export function heroView(st, settings) {
  const c = st.character || {};
  const a = c.attrs || {};
  const hs = heroStats(st);
  const lines = [`🧝 <b>${esc(c.appearance?.nick || 'Hero')}</b> · ${esc(c.className || '')} · Lv ${c.level} · ⚡ Power <b>${n(heroPower(st))}</b>`,
    `❤️ ${n(hs.maxHp)} HP · ⚔️ ${n(hs.dmg)} DMG · 💥 crit ${Math.round(hs.crit * 100)}% ×${(1 + hs.critDmg).toFixed(1)} · 🛡 block ${Math.round(hs.block * 100)}% · 🩸 ${(hs.lifesteal * 100).toFixed(1)}% · 💨 ${n(hs.speed)}`, ''];
  lines.push('<b>Attribute</b>' + (c.sp ? ` — 📈 ${c.sp} poin bebas` : ''));
  for (const [k, label, eff] of ATTR_INFO) lines.push(`${label}: <b>${a[k] || 0}</b>  <i>${eff}</i>`);
  lines.push('', '<b>Gear terpasang</b>');
  for (const slot of CAT.slots) {
    const id = st.equipped?.[slot];
    lines.push(`${SLOT_ICON[slot]} ${SLOT_NAME[slot]}: ${id ? itemLabel(id, { short: true }) : '—'}`);
  }
  const active = st.pets?.activePet;
  lines.push(`🐾 Pet: ${active ? esc(petInfo(active).name) : '—'}`);
  lines.push('', `Build autopilot: <b>${BUILDS[settings.build]?.name || settings.build}</b>${settings.build === 'auto' ? ` → ${BUILDS[resolveBuild('auto', c.classId)].name}` : ''}`);
  const kb = new InlineKeyboard();
  if (c.sp) {
    ATTR_INFO.forEach(([k, label], i) => { kb.text(`+1 ${label.split(' ')[1]}`, 'hero:attr:' + k); if (i === 2) kb.row(); });
    kb.row().text(`✨ Auto-alokasi ${c.sp} SP`, 'hero:auto');
  }
  kb.row().text('🧥 Equip best', 'hero:best').text('🏗 Ganti build', 'hero:build').row().text('🛍 Upgrade dari Market', 'upg:plan');
  return { text: lines.join('\n'), kb: back(kb) };
}

// ---------------------------------------------------------------- inventory
const PAGE = 8;
export function invView(items, page = 0) {
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = items.slice(page * PAGE, page * PAGE + PAGE);
  const lines = [`🎒 <b>Inventory</b> — ${items.length} jenis item`, ''];
  if (!items.length) lines.push('Tas kosong. Klaim loot dulu di 🎁 Loot & AFK.');
  const kb = new InlineKeyboard();
  for (const it of slice) kb.text(itemLabel(it.id, { qty: it.qty }), 'it:v:' + it.id).row();
  if (pages > 1) {
    if (page > 0) kb.text('◀️', 'nav:inv:' + (page - 1));
    kb.text(`${page + 1}/${pages}`, 'noop');
    if (page < pages - 1) kb.text('▶️', 'nav:inv:' + (page + 1));
    kb.row();
  }
  kb.text('🧥 Equip best', 'hero:best').text('♻️ Salvage', 'salv:menu').row().text('🛍 Upgrade dari Market', 'upg:plan');
  return { text: lines.join('\n'), kb: back(kb) };
}

export function itemView(st, id) {
  const info = itemInfo(id);
  const qty = st.items?.[id] || 0;
  const worn = Object.entries(st.equipped || {}).find(([, v]) => v === id)?.[0];
  const lines = [`${itemLabel(id)}`, `<i>${info.rarity}${info.slot ? ' · ' + SLOT_NAME[info.slot] : ''}${info.weaponType ? ' · ' + info.weaponType : ''}</i>`, ''];
  if (info.kind === 'gear') {
    for (const [k, v] of Object.entries(itemStats(info))) lines.push('• ' + fmtStat(k, v));
    if (info.earn) lines.push(`• +${Math.round(info.earn * 100)}% $LM earnings`);
    const cls = st.character?.classId;
    if (info.slot === 'weapon' && cls && info.weaponType !== cls) lines.push('', '🔒 Senjata class lain, tidak bisa dipakai.');
  }
  lines.push('', `Jumlah: ${qty}${worn ? ' · ✅ sedang dipakai' : ''}`);
  const kb = new InlineKeyboard();
  if (info.kind === 'gear') {
    if (worn) kb.text('❎ Lepas', 'it:un:' + worn); else kb.text('✅ Pakai', 'it:eq:' + id);
    kb.text('🔨 Forge +1', 'it:fg:' + id + ':1').text('🔨 +5', 'it:fg:' + id + ':5').row();
    kb.text('🏪 Jual di Market', 'it:sell:' + id).text('🗑 Buang 1', 'it:del:' + id);
  } else if (info.kind === 'chest') {
    kb.text('📦 Buka chest', 'shop:open:' + info.baseId);
  }
  return { text: lines.join('\n'), kb: back(kb, 'inv:0') };
}

export function salvageView(st) {
  const lines = ['♻️ <b>Salvage</b>', '', 'Gear di tas yang belum di-forge dipecah jadi Bone (bahan forge & seal). Gear yang dipakai, item forge (+), dan Mythic tidak ikut.', '', 'Bone per item (docs): Common 30 · Uncommon 80 · Rare 200 · Epic 500 · Legendary 1.200'];
  const kb = new InlineKeyboard()
    .text('⚪ s/d Common', 'salv:0').text('🟢 s/d Uncommon', 'salv:1').row()
    .text('🔵 s/d Rare', 'salv:2');
  return { text: lines.join('\n'), kb: back(kb, 'inv:0') };
}

// ---------------------------------------------------------------- loot & afk
export function lootView(st, afk) {
  const p = st.pendingLoot || {};
  const lines = ['🎁 <b>Loot & AFK</b>', '', `<b>Loot chest</b>: ${n(p.drops)} drop · ${n(p.bone)} Bone · ${p.items?.length || 0} item`];
  if (afk) {
    const r = afk.rewards || {};
    lines.push('', `<b>AFK</b> (${dur(afk.seconds)} dari maks ${dur(afk.cap || 28800)})`, `≈ +${n(r.lm)} $LM · +${n(r.xp)} XP · +${n(r.bone)} Bone · ${n(r.kills)} kill${r.items?.length ? ` · ${r.items.length} item` : ''}`, `<i>basis: ${esc(r.basis || '-')}</i>`);
  }
  lines.push('', '<i>AFK dibayar 75% dari rate online kamu (24 jam terakhir), maks 8 jam per klaim. Main online di browser = rate AFK ikut naik.</i>');
  const kb = new InlineKeyboard().text('🎁 Klaim loot', 'loot:claim').text('💤 Klaim AFK', 'afk:claim').row().text('👀 Cek AFK', 'afk:prev');
  return { text: lines.join('\n'), kb: back(kb) };
}

// ---------------------------------------------------------------- quest
export function questView(d) {
  const lines = ['📜 <b>Quest harian</b>', ''];
  for (const m of d.missions || []) {
    const mark = m.claimed ? '✅' : m.complete ? '🎁' : '▫️';
    lines.push(`${mark} <b>${esc(m.title)}</b> (${m.difficulty}) — ${n(Math.min(m.progress, m.target))}/${n(m.target)}`, `    <i>${esc(m.description)}</i> → ${n(m.reward?.Bone)} Bone, ${n(m.reward?.XP)} XP`);
  }
  const b = d.board || {};
  lines.push('', `🏅 Daily reward: ${b.completed}/${b.required} ${b.claimed ? '✅ diklaim' : b.complete ? '🎁 siap' : ''} → ${n(b.reward?.Bone)} Bone + ${n(b.reward?.XP)} XP`);
  const l = d.login || {};
  lines.push(`📅 Login streak: hari ${l.nextDay ?? '?'} ${l.claimedToday ? '✅ sudah' : '🎁 siap'}`);
  if (d.community) lines.push(`🐦 Share your run: ${esc(d.community.status)} (5.000 $LM/hari, submit di web)`);
  lines.push('', `Reset dalam ${dur(d.resetAt - d.serverNow)} (00:00 UTC)`);
  const kb = new InlineKeyboard().text('🎁 Klaim semua', 'quest:claim');
  return { text: lines.join('\n'), kb: back(kb) };
}

// ---------------------------------------------------------------- pass
export function passValue(p) {
  const prem = { lm: 0, bone: 0, items: [] }; const free = { lm: 0, bone: 0, items: [] };
  const add = (acc, r) => { if (!r) return; acc.lm += r.lm || 0; acc.bone += r.bone || 0; if (r.item) acc.items.push(itemInfo(r.item).name); if (r.petChest) acc.items.push(CAT.petChests[r.petChest]?.name || r.petChest); };
  for (const t of p.tiers || []) { add(free, t.free); add(prem, t.premium); }
  return { free, prem };
}

export function passView(p, st) {
  const s = p.season || {};
  const now = Date.now() / 1000;
  const into = p.xp - p.tier * p.tierXp;
  const lines = [
    `🎫 <b>${esc(s.name || 'March Pass')}</b>`,
    `Tier <b>${p.tier}</b>/${p.maxTier} · ${n(Math.max(0, into))}/${n(p.tierXp)} XP ke tier berikutnya`,
    `Hari ini: ${n(p.today?.rooms)} room → ${n(p.today?.roomXp)}/${n(p.xpRules?.roomDailyCap)} pass XP dari room`,
    `Season berakhir ${dur(s.end - now)} lagi · klaim s/d ${dur(s.claimUntil - now)}`,
    '', `Premium: ${p.premium ? '♛ <b>AKTIF</b>' : `belum — $${p.premiumUsd} (= ${n(p.premiumLmPrice)} $LM)`}`,
  ];
  if (!p.premium) {
    const { prem } = passValue(p);
    lines.push(`Isi track premium: ${n(prem.lm)} $LM${usd(prem.lm, st)} + ${n(prem.bone)} Bone + ${prem.items.join(', ')}`);
    lines.push('Lihat analisa 🧮 sebelum beli.');
  }
  const kb = new InlineKeyboard();
  if (p.claimable) kb.text('🎁 Klaim tier', 'pass:claim').row();
  if (!p.premium && s.active) kb.text('🧮 Analisa premium', 'pass:calc').row().text(`♛ Beli pakai $LM`, 'pass:buylm').text('♛ Beli pakai ETH', 'pass:buyeth');
  return { text: lines.join('\n'), kb: back(kb) };
}

// Is premium worth it? Value of the premium track vs its price, scaled by
// how many tiers are realistically reachable before the season ends.
export function passCalc(p, st, dailyXp = 1000) {
  const now = Date.now() / 1000;
  const daysLeft = Math.max(0, (p.season.end - now) / 86400);
  const reach = Math.min(p.maxTier, Math.floor((p.xp + dailyXp * daysLeft) / p.tierXp));
  const lmUsd = st?.prices?.lmUsd || 0;
  const chestUsd = { chest_common: 0.1, chest_rare: 1, chest_epic: 3, chest_legendary: 7 };
  const petUsd = CAT.petChestUsd;
  let lm = 0; let bone = 0; let extra = 0;
  (p.tiers || []).slice(0, reach).forEach((t) => {
    const r = t.premium || {};
    lm += r.lm || 0; bone += r.bone || 0;
    if (r.item) extra += chestUsd[r.item] || 0;
    if (r.petChest) extra += petUsd[r.petChest] || 0;
  });
  const boneUsd = (st?.prices?.bonePack?.lm && lmUsd) ? (st.prices.bonePack.lm * lmUsd) / st.prices.bonePack.bone : 0;
  const value = lm * lmUsd + bone * boneUsd + extra;
  return { reach, daysLeft, lm, bone, extra, value, cost: p.premiumUsd, boneUsd };
}

// ---------------------------------------------------------------- travel
export function travelView(st, readyIn, floorSel) {
  const pr = st.progress || {};
  const unlocked = pr.floor_unlocked || 1;
  const best = pr.best_depth || 0;
  const floor = floorSel || pr.floor || 1;
  const lines = [`🗺 <b>Travel</b>`, `Sekarang: Floor ${pr.floor} · ${esc(regionName(pr.zone_index))} · terdalam depth ${best}`, readyIn ? `⏳ Travel lagi dalam ${dur(readyIn)}` : '✅ Travel siap', '', `<b>Floor ${floor}</b>:`];
  const kb = new InlineKeyboard();
  for (let z = 0; z < ZONES_PER_FLOOR; z++) {
    const d = depth(floor, z);
    const open = d <= Math.max(best + 1, 1) && floor <= unlocked;
    const here = pr.floor === floor && pr.zone_index === z;
    lines.push(`${here ? '📍' : open ? '▫️' : '🔒'} ${z + 1}. ${esc(regionName(z))}`);
    if (open && !here) kb.text(`${z + 1}. ${regionName(z)}`, `tr:go:${floor}:${z}`);
    if (open && !here && z % 2 === 1) kb.row();
  }
  kb.row();
  for (let f = 1; f <= unlocked; f++) if (f !== floor) kb.text(`Floor ${f}`, 'nav:travel:' + f);
  const nextFloor = unlocked + 1;
  const cost = sealCost(nextFloor);
  lines.push('', `🔐 Seal Floor ${nextFloor}: ${n(cost.lm)} $LM + ${n(cost.bone)} Bone (semua 11 region floor ${unlocked} harus clear)`);
  kb.row().text(`🔓 Buka seal Floor ${nextFloor}`, 'tr:seal:' + nextFloor);
  lines.push('', '<i>Tips profit: farm region terdalam yang masih bisa kamu tahan, $LM naik +4,5%/region & ×1,5/floor.</i>');
  return { text: lines.join('\n'), kb: back(kb) };
}

// ---------------------------------------------------------------- shop
export function shopView(st) {
  const pc = st.prices?.chests || {};
  const owned = (id) => st.items?.[id] || 0;
  const lines = ['🛒 <b>Shop</b>', `Saldo: ${n(st.balances?.LM)} $LM · ${n(st.balances?.Bone)} Bone`, '', '<b>Chest gear</b> (harga $LM live)'];
  const kb = new InlineKeyboard();
  for (const id of SHOP_CHESTS) {
    const c = itemInfo(id);
    lines.push(`${RARITY_ICON[c.rarity]} ${c.name}: ${n(pc[id])} $LM${usd(pc[id], st)}${owned(id) ? ` · punya ${owned(id)}` : ''}`);
    kb.text(c.name.replace(' Chest', ''), 'shop:c:' + id);
    if (SHOP_CHESTS.indexOf(id) % 3 === 2) kb.row();
  }
  kb.row();
  const pp = st.petChestTestLm?.prices || {};
  lines.push('', '<b>Pet chest</b>');
  for (const t of PET_CHESTS) {
    lines.push(`🐾 ${CAT.petChests[t]?.name || t}: ${pp[t] ? n(pp[t]) + ' $LM' : '-'}${st.petChests?.[t] ? ` · punya ${st.petChests[t]}` : ''}`);
    kb.text('🐾 ' + t, 'shop:p:' + t);
  }
  const bp = st.prices?.bonePack;
  if (bp) {
    lines.push('', `🦴 Bone pack: ${n(bp.bone)} Bone = ${n(bp.lm)} $LM`);
    kb.row().text('🦴 ×1', 'shop:bone:1').text('🦴 ×5', 'shop:bone:5').text('🦴 ×10', 'shop:bone:10');
  }
  return { text: lines.join('\n'), kb: back(kb) };
}

export function chestView(st, id) {
  const c = itemInfo(id);
  const price = st.prices?.chests?.[id];
  const own = st.items?.[id] || 0;
  const odds = {
    chest_common: '60% C · 30% U · 8% R · 1.8% E · 0.2% L', chest_rare: '20% C · 40% U · 30% R · 8% E · 2% L',
    chest_epic: '20% U · 40% R · 32% E · 8% L', chest_legendary: '20% R · 45% E · 35% L',
    chest_mythic_weapon: 'Mythic weapon class kamu (dijamin) + bonus $LM besar', chest_mythic_equipment: 'Mythic non-senjata (dijamin)',
  };
  const lines = [`${RARITY_ICON[c.rarity]} <b>${c.name}</b>`, `Harga: ${n(price)} $LM${usd(price, st)}`, `Peluang: ${odds[id] || '-'}`, `Kamu punya: ${own}`];
  const kb = new InlineKeyboard().text('💰 Beli pakai $LM', 'shop:buy:' + id).text('Ξ Beli pakai ETH', 'shop:eth:' + id);
  if (own) kb.row().text(`📦 Buka (${own})`, 'shop:open:' + id);
  return { text: lines.join('\n'), kb: back(kb, 'shop') };
}

// ---------------------------------------------------------------- pets
export function petView(st) {
  const owned = st.pets?.owned || [];
  const active = st.pets?.activePet;
  const lines = ['🐾 <b>Pet</b>', `${owned.length} pet dimiliki · Bone ${n(st.balances?.Bone)}`, ''];
  const kb = new InlineKeyboard();
  if (!owned.length) lines.push('Belum punya pet. Buka pet chest di 🛒 Shop atau beli di 🏪 Market.');
  for (const p of owned) {
    const info = petInfo(p.petId); const pg = petProgress(p.xp || 0);
    lines.push(`${p.petId === active ? '⭐' : RARITY_ICON[info.rarity]} <b>${esc(info.name)}</b> Lv ${pg.level}${pg.max ? ' (MAX)' : ` · ${n(pg.into)}/${n(pg.need)} XP`}`);
    kb.text(`${p.petId === active ? '⭐ ' : ''}${info.name}`, 'pet:v:' + p.petId).row();
  }
  const chests = Object.entries(st.petChests || {}).filter(([, v]) => v > 0);
  if (chests.length) {
    lines.push('', 'Pet chest belum dibuka: ' + chests.map(([k, v]) => `${k} ×${v}`).join(', '));
    for (const [k] of chests) kb.text(`📦 Buka ${k}`, 'shop:popen:' + k);
  }
  lines.push('', '<i>Duplikat otomatis jadi XP pet. Feed: 1 Bone = 10 XP (+1 $LM). Lv maks 10, +10% bonus/level.</i>');
  return { text: lines.join('\n'), kb: back(kb) };
}

export function petDetail(st, petId) {
  const p = (st.pets?.owned || []).find((x) => x.petId === petId) || { petId, xp: 0 };
  const info = petInfo(petId); const pg = petProgress(p.xp || 0);
  const active = st.pets?.activePet === petId;
  const lines = [`${RARITY_ICON[info.rarity]} <b>${esc(info.name)}</b> ${active ? '⭐ dipakai' : ''}`, `Lv ${pg.level}/10 · XP ${n(p.xp)}${pg.max ? ' (MAX)' : ` · butuh ${n(pg.boneToNext)} Bone ke Lv ${pg.level + 1}`}`, `Ability: ${PET_ABILITY[info.baseId] || '-'}`, '', '<b>Bonus</b>'];
  for (const [k, v] of Object.entries(petBonus(petId, pg.level))) lines.push('• ' + fmtStat(k, v));
  const kb = new InlineKeyboard().text(active ? '❎ Lepas' : '✅ Pakai', active ? 'pet:eq:none' : 'pet:eq:' + petId).row();
  if (!pg.max) {
    kb.text('🦴 Feed 100', `pet:feed:${petId}:100`).text('🦴 Feed 1000', `pet:feed:${petId}:1000`).row();
    kb.text(`🦴 Ke Lv ${pg.level + 1} (${n(pg.boneToNext)})`, `pet:feed:${petId}:${pg.boneToNext}`);
  }
  kb.row().text('🏪 Jual di Market', 'it:sell:' + PET_PREFIX + petId);
  return { text: lines.join('\n'), kb: back(kb, 'pet') };
}

// ---------------------------------------------------------------- codex
export function codexView(st) {
  const cx = st.codex || {};
  const gearTotal = CAT.items.length;
  const lines = ['📖 <b>Codex</b>', '', `👹 Musuh: ${(cx.enemies || []).length}`, `💀 Boss: ${(cx.bosses || []).length}`, `🗡 Item ditemukan: ${(cx.items || []).length}/${gearTotal}`, `🗺 Region: ${(cx.regions || []).length || '-'}`];
  const byR = {};
  for (const id of cx.items || []) { const r = itemInfo(id).rarity; byR[r] = (byR[r] || 0) + 1; }
  const tot = {};
  for (const i of CAT.items) tot[i.rarity] = (tot[i.rarity] || 0) + 1;
  lines.push('', ...CAT.rarities.map((r) => `${RARITY_ICON[r]} ${r}: ${byR[r] || 0}/${tot[r] || 0}`));
  const petOwned = new Set((st.pets?.owned || []).map((p) => p.petId));
  lines.push('', `🐾 Koleksi pet: ${petOwned.size}/${CAT.petVariants.length}`);
  for (const base of CAT.pets) {
    const row = CAT.petVariants.filter((v) => v.baseId === base.id).map((v) => (petOwned.has(v.id) ? RARITY_ICON[v.rarity] : '▫️')).join('');
    lines.push(`${esc(base.name)}: ${row}`);
  }
  if (cx.enemies?.length) lines.push('', 'Musuh: ' + esc(cx.enemies.join(', ')));
  return { text: lines.join('\n'), kb: back(new InlineKeyboard()) };
}

// ---------------------------------------------------------------- market
const RAR_F = ['all', ...CAT.rarities];
const SLOT_F = ['all', ...CAT.slots, 'pet'];
export function marketView(st, data, { rarity = 'all', slot = 'all', page = 0 }) {
  let rows = data.listings || [];
  if (slot === 'pet') rows = rows.filter((l) => l.petXp != null || String(l.itemId).includes(':'));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const lines = [`🏪 <b>Market</b> — ${rows.length} listing · filter: ${rarity}/${slot}`, `Saldo ${n(st.balances?.LM)} $LM · pembeli bayar +5% fee`, ''];
  const kb = new InlineKeyboard();
  for (const l of rows.slice(page * PAGE, page * PAGE + PAGE)) {
    const name = l.itemId.includes(':') ? petInfo(l.itemId).name : itemLabel(l.itemId, { short: true });
    kb.text(`${name} · ${n(l.price)}`, 'mk:v:' + l.id).row();
  }
  if (!rows.length) lines.push('Tidak ada listing untuk filter ini.');
  const nr = RAR_F[(RAR_F.indexOf(rarity) + 1) % RAR_F.length];
  const ns = SLOT_F[(SLOT_F.indexOf(slot) + 1) % SLOT_F.length];
  if (pages > 1) {
    if (page > 0) kb.text('◀️', `nav:mk:${rarity}:${slot}:${page - 1}`);
    kb.text(`${page + 1}/${pages}`, 'noop');
    if (page < pages - 1) kb.text('▶️', `nav:mk:${rarity}:${slot}:${page + 1}`);
    kb.row();
  }
  kb.text(`🎚 Rarity: ${rarity}`, `nav:mk:${nr}:${slot}:0`).text(`🎚 Slot: ${slot}`, `nav:mk:${rarity}:${ns}:0`).row();
  kb.text('📋 Listing saya', 'mk:mine').text('🧾 Riwayat', 'mk:hist');
  return { text: lines.join('\n'), kb: back(kb) };
}

export function listingView(st, l) {
  const pet = String(l.itemId).includes(':');
  const lines = [pet ? `🐾 <b>${esc(petInfo(l.itemId).name)}</b>` : itemLabel(l.itemId), `Penjual: ${esc(l.seller)}`, `Harga: <b>${n(l.price)}</b> $LM${usd(l.price, st)}`, `Total + fee 5%: ${n(Math.ceil(l.price * 1.05))} $LM`];
  if (!pet) for (const [k, v] of Object.entries(itemStats(itemInfo(l.itemId)))) lines.push('• ' + fmtStat(k, v));
  if (l.petXp != null) lines.push(`Pet Lv ${petProgress(l.petXp).level}`);
  const kb = new InlineKeyboard().text('🛒 Beli', 'mk:buy:' + l.id);
  return { text: lines.join('\n'), kb: back(kb, 'mk:all:all:0') };
}

export function myListingsView(st) {
  const mine = st.market || [];
  const lines = ['📋 <b>Listing saya</b> (maks 5)', ''];
  const kb = new InlineKeyboard();
  if (!mine.length) lines.push('Belum ada listing. Jual dari 🎒 Inventory → item → 🏪 Jual.');
  for (const l of mine) {
    const name = String(l.itemId).includes(':') ? petInfo(l.itemId).name : itemLabel(l.itemId, { short: true });
    lines.push(`• ${name} — ${n(l.price)} $LM`);
    kb.text(`❌ Batal: ${name}`, 'mk:cancel:' + l.id).row();
  }
  lines.push('', '<i>Fee listing 2,5% dibayar di depan (tidak kembali kalau batal).</i>');
  return { text: lines.join('\n'), kb: back(kb, 'mk:all:all:0') };
}

export function historyView(h, nick) {
  const lines = ['🧾 <b>Riwayat market</b>', ''];
  const rows = (h.mine || h.recent || []).slice(0, 15);
  for (const r of rows) {
    const side = r.side || (r.seller === nick ? 'jual' : r.buyer === nick ? 'beli' : '');
    lines.push(`• ${String(r.itemId).includes(':') ? esc(petInfo(r.itemId).name) : itemLabel(r.itemId, { short: true })} — ${n(r.price)} $LM ${side ? `(${side})` : `${esc(r.seller)} → ${esc(r.buyer)}`}`);
  }
  if (!rows.length) lines.push('Kosong.');
  return { text: lines.join('\n'), kb: back(new InlineKeyboard(), 'mk:all:all:0') };
}

// ---------------------------------------------------------------- ranks
export function ranksView(lb) {
  const lines = ['🏆 <b>Ranks</b>'];
  const names = { deepest: 'Terdalam', level: 'Level' };
  for (const [k, rows] of Object.entries(lb.boards || {})) {
    lines.push('', `<b>${names[k] || k}</b>`);
    for (const r of rows.slice(0, 10)) lines.push(`${r.rank}. ${r.you ? '👉 ' : ''}${r.pass ? '♛ ' : ''}${esc(r.name)} ${CLASS_ICON[r.classId] || ''} — ${r.depth != null ? `F${r.floor} ${esc(r.region || '')}` : `Lv ${r.level}`}`);
    const me = rows.find((r) => r.you);
    if (me && me.rank > 10) lines.push(`… ${me.rank}. 👉 ${esc(me.name)}`);
  }
  return { text: lines.join('\n'), kb: back(new InlineKeyboard()) };
}

// ---------------------------------------------------------------- wallet
export function walletView({ address, eth, lm, game, dep, wd, explorer, fmtEth, fmtLm }) {
  const lines = ['💰 <b>Wallet</b> (Robinhood Chain)', ''];
  if (!address) {
    lines.push('Belum ada wallet. Import private key wallet yang kamu pakai login di lootmarch.xyz, atau buat wallet baru.');
    const kb = new InlineKeyboard().text('🔑 Import key', 'w:import').text('✨ Buat baru', 'w:new');
    return { text: lines.join('\n'), kb: back(kb) };
  }
  lines.push(`<code>${address}</code>`, `<a href="${explorer}/address/${address}">Lihat di explorer</a>`, '');
  lines.push(`Ξ ETH: <b>${eth != null ? fmtEth(eth) : '?'}</b>`, `🪙 $LM on-chain: <b>${lm != null ? fmtLm(lm) : '?'}</b>`, `🎮 $LM di game: <b>${n(game)}</b>`);
  if (dep) lines.push('', `Deposit: ${dep.open ? '✅ buka' : '⛔ tutup'}`);
  if (wd) lines.push(`Withdraw: ${wd.open ? '✅ buka' : '⛔ tutup'} · ${n(wd.min)}–${n(wd.max)} $LM · ${wd.usedToday}/${wd.perDay} hari ini · wallet wajib pegang ≥ ${n(wd.holdMin)} $LM`);
  for (const r of (wd?.requests || []).slice(0, 3)) lines.push(`  • ${n(r.amount)} $LM — ${esc(r.status || r.state || '?')}`);
  const kb = new InlineKeyboard()
    .text('⬇️ Deposit $LM', 'w:dep').text('⬆️ Withdraw', 'w:wd').row()
    .text('📤 Kirim ETH', 'w:send:eth').text('📤 Kirim $LM', 'w:send:lm').row()
    .text('🧾 Klaim pakai tx hash', 'w:claim').text('🔄 Refresh', 'nav:wallet').row()
    .text('🔑 Ganti key', 'w:import').text('👁 Lihat private key', 'w:reveal');
  return { text: lines.join('\n'), kb: back(kb) };
}

// ---------------------------------------------------------------- settings
export function settingsView(s, { address, session }) {
  const lines = ['⚙️ <b>Setelan</b>', '', `Wallet: ${address ? `<code>${address}</code>` : '—'}`, `Login game: ${session ? '✅ ' + session : '❌ belum'}`, '', '<b>Autopilot</b> (cek tiap beberapa menit)'];
  const kb = new InlineKeyboard();
  const t = (k, label) => kb.text(`${ON(s[k])} ${label}`, 'set:t:' + k);
  t('autoAfk', `AFK tiap ${s.afkHours}j`); t('autoLoot', 'Klaim loot'); kb.row();
  t('autoEquip', 'Equip best'); t('autoAttr', 'Auto attribute'); kb.row();
  t('autoSalvage', `Salvage s/d ${CAT.rarities[s.salvageLevel]}`); t('autoForge', 'Auto forge'); kb.row();
  t('autoDaily', 'Quest'); t('autoPass', 'Pass'); kb.row();
  t('autoSeal', 'Auto seal floor'); t('autoTravel', 'Travel floor baru'); kb.row();
  t('autoChest', 'Buka chest'); t('autoSell', 'Jual gear sisa'); kb.row();
  t('autoUpgrade', `Upgrade market (${Math.round(s.upgradeShare * 100)}% $LM)`); kb.row();
  t('alertLive', 'Alert live check'); t('alertDrops', 'Alert drop global'); kb.row();
  t('reports', 'Laporan autopilot'); kb.row();
  kb.text(`⏱ AFK: ${s.afkHours}j`, 'set:afk').text(`🏗 Build: ${BUILDS[s.build]?.name}`, 'hero:build').row();
  kb.text(`♻️ Salvage: ${CAT.rarities[s.salvageLevel]}`, 'set:salv').text(`🔨 Cadangan: ${n(s.forgeReserveLm)} LM`, 'set:fres').row();
  kb.text('🔐 Login ulang', 'set:login').text('🚪 Logout game', 'set:logout');
  lines.push(`Forge otomatis hanya jalan kalau $LM > ${n(s.forgeReserveLm)} dan Bone > ${n(s.forgeReserveBone)}.`);
  return { text: lines.join('\n'), kb: back(kb) };
}

export function buildPicker(cur, classId) {
  const kb = new InlineKeyboard();
  const auto = resolveBuild('auto', classId);
  const lines = ['🏗 <b>Pilih build attribute</b>', '', 'Semua class punya base stat & efek attribute yang sama; bedanya hanya skill senjata. Nilai 1 poin menurut rumus Power game: STR ≈13 · VIT 6,4 · DEF 5 · VAM 3,75 · AGI 1,2.', ''];
  for (const [id, b] of Object.entries(BUILDS)) {
    const share = BUILDS[id === 'auto' ? auto : id].share;
    const mix = Object.entries(share).filter(([, v]) => v).map(([k, v]) => `${k.toUpperCase()} ${Math.round(v * 100)}%`).join(' · ');
    lines.push(`<b>${b.name}</b>${id === 'auto' ? ` → ${BUILDS[auto].name} untuk ${esc(classId || '?')}` : ''}: ${mix}`);
    kb.text(`${cur === id ? '✅ ' : ''}${b.name}`, 'hero:setbuild:' + id);
    if (id === 'balanced') kb.row();
  }
  lines.push('', `<i>Wand/Spear (jarak jauh) → Damage. Sword/Axe/Dagger (jarak dekat) → Seimbang. VAM & AGI maks ${VAM_CAP} poin.</i>`);
  return { text: lines.join('\n'), kb: back(kb, 'hero') };
}

export function upgradeView(st, plan) {
  const lines = ['🛍 <b>Upgrade gear dari Market</b>', `Power sekarang ⚡ ${n(plan.base)} · saldo ${n(st.balances?.LM)} $LM`, ''];
  if (!plan.picks.length) lines.push('Belum ada upgrade yang terjangkau. Kumpulkan $LM dulu atau deposit dari wallet (💰 Wallet → ⬇️ Deposit).');
  for (const p of plan.picks) {
    const cur = st.equipped?.[p.slot];
    lines.push(`${SLOT_ICON[p.slot]} ${itemLabel(p.listing.itemId, { short: true })} — ${n(p.cost)} $LM (+${n(p.gain)} Power)`, `    <i>ganti: ${cur ? itemLabel(cur, { short: true }) : 'slot kosong'}</i>`);
  }
  if (plan.picks.length) lines.push('', `Total: <b>${n(plan.spend)} $LM</b>${usd(plan.spend, st)} → Power ⚡ ${n(plan.base)} → <b>${n(plan.base + plan.gain)}</b>`, '<i>Harga sudah termasuk fee pembeli 5%. Dipilih dengan kenaikan Power terbesar per $LM, senjata sesuai class.</i>');
  const kb = new InlineKeyboard();
  if (plan.picks.length) kb.text(`✅ Beli & pakai semua (${n(plan.spend)} $LM)`, 'upg:buy').row();
  kb.text('🔄 Hitung ulang', 'upg:plan');
  return { text: lines.join('\n'), kb: back(kb, 'hero') };
}

// ---------------------------------------------------------------- new hero
const CLASS_ORDER = ['wand', 'spear', 'axe', 'sword', 'dagger'];
export function newHeroClassView() {
  const lines = ['🆕 <b>Buat hero</b> — langkah 1/3: pilih class', '', 'Semua class punya stat dasar sama; bedanya skill senjata (otomatis tiap 7 detik). Senjata terkunci ke class, <b>hero hanya dibuat sekali</b>.', ''];
  const kb = new InlineKeyboard();
  for (const id of CLASS_ORDER) {
    const c = CLASS_INFO[id];
    lines.push(`${CLASS_ICON[id]} <b>${id.toUpperCase()}</b> — ${c.skill}${id === 'wand' ? ' ⭐ rekomendasi' : ''}`, `    <i>${c.text}</i>`);
    kb.text(`${CLASS_ICON[id]} ${id.toUpperCase()}${id === 'wand' ? ' ⭐' : ''}`, 'new:class:' + id);
    if (id === 'spear' || id === 'sword') kb.row();
  }
  return { text: lines.join('\n'), kb };
}

export function newHeroLookView(d) {
  const L = d.look;
  const lines = ['🆕 <b>Buat hero</b> — langkah 3/3: cek & konfirmasi', '',
    `${CLASS_ICON[d.classId]} Class: <b>${d.classId.toUpperCase()}</b> (${CLASS_INFO[d.classId].skill})`,
    `🏷 Nama: <b>${esc(d.nick)}</b>`,
    `🎨 Tampilan: skin ${L.skin} · wajah ${L.face} · rambut ${L.hairStyle}/${L.hairCol} · baju ${L.clothStyle}/${L.clothCol}`,
    '', '<i>Tampilan hanya kosmetik. Setelah dibuat, class & nama tidak bisa diganti.</i>'];
  const kb = new InlineKeyboard().text('🎲 Acak tampilan', 'new:look:rand').text('↩️ Default class', 'new:look:def').row()
    .text('✏️ Ganti nama', 'new:nick').text('🔁 Ganti class', 'new:start').row()
    .text('✅ Buat hero sekarang', 'new:go');
  return { text: lines.join('\n'), kb };
}
export const NICK_RULE = `1–${NICK_MAX} karakter, huruf/angka/spasi/_`;

export function confirmKb(token) {
  return new InlineKeyboard().text('✅ Ya, lanjut', 'cf:' + token).text('❌ Batal', 'nav:home');
}
