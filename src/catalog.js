import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../data/catalog.json', import.meta.url));
export const CAT = JSON.parse(fs.readFileSync(file, 'utf8'));

const ITEMS = new Map(CAT.items.map((i) => [i.id, i]));
const CHESTS = new Map(CAT.chests.map((c) => [c.id, c]));
const PETS = new Map(CAT.petVariants.map((p) => [p.id, p]));

export const RARITY_ICON = { common: '⚪', uncommon: '🟢', rare: '🔵', epic: '🟣', legendary: '🟠', mythic: '🔴' };
export const RARITY_RANK = Object.fromEntries(CAT.rarities.map((r, i) => [r, i]));
export const SLOT_ICON = { weapon: '🗡', helmet: '⛑', armor: '🥋', shield: '🛡', boots: '👢', ring: '💍', amulet: '📿' };
export const SLOT_NAME = { weapon: 'Senjata', helmet: 'Helm', armor: 'Armor', shield: 'Perisai', boots: 'Sepatu', ring: 'Cincin', amulet: 'Kalung' };
export const CLASS_ICON = { sword: '⚔️', spear: '🔱', wand: '🪄', axe: '🪓', dagger: '🗡' };
// Per-forge-level stat growth (docs: Forge).
export const FORGE_GROWTH = { common: 0.04, uncommon: 0.05, rare: 0.06, epic: 0.08, legendary: 0.11, mythic: 0.15 };
export const MAX_PLUS = 60;
export const ZONES_PER_FLOOR = CAT.regions.length; // 11

export function splitId(id) {
  const s = String(id);
  const i = s.indexOf('@');
  if (i < 0) return { baseId: s, plus: 0 };
  const plus = Number(s.slice(i + 1));
  return { baseId: s.slice(0, i), plus: Number.isInteger(plus) && plus > 0 ? plus : 0 };
}

export function itemInfo(id) {
  const { baseId, plus } = splitId(id);
  const base = ITEMS.get(baseId);
  if (base) return { ...base, id: String(id), baseId, plus, kind: 'gear' };
  const chest = CHESTS.get(baseId);
  if (chest) return { ...chest, id: String(id), baseId, plus: 0, kind: 'chest' };
  return { id: String(id), baseId, plus, name: prettify(baseId), rarity: 'common', kind: 'unknown' };
}

export function petInfo(id) {
  const p = PETS.get(id);
  if (p) return p;
  const [base, rarity = 'common'] = String(id).split(':');
  return { id, baseId: base, name: prettify(base), rarity, bonus: {} };
}

export const prettify = (s) => String(s).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function itemStats(info) {
  const g = FORGE_GROWTH[info.rarity] ?? 0.04;
  const mul = 1 + g * (info.plus || 0);
  const out = {};
  for (const [k, v] of Object.entries(info.stats || {})) out[k] = v * mul;
  return out;
}

export function fmtStat(key, v) {
  const kind = CAT.statKinds[key]?.kind;
  const label = CAT.statLabels[key] || key;
  const sign = key === 'cdr' ? '-' : '+';
  if (kind === 'pct') return `${label} ${sign}${(Math.round(v * 1000) / 10).toString()}%`;
  if (kind === 'rate') return `${label} ${sign}${(Math.round(v * 10) / 10).toFixed(1)}`;
  return `${label} ${sign}${Math.round(v)}`;
}

export function itemLabel(id, { qty = 0, short = false } = {}) {
  const info = itemInfo(id);
  const plus = info.plus ? ` +${info.plus}` : '';
  const q = qty > 1 ? ` ×${qty}` : '';
  const slot = !short && info.slot ? (SLOT_ICON[info.slot] || '') + ' ' : '';
  return `${RARITY_ICON[info.rarity] || '▫️'} ${slot}${info.name}${plus}${q}`;
}

export function regionName(zoneIndex) {
  return CAT.regions[zoneIndex]?.name || `Region ${zoneIndex + 1}`;
}

export function xpToNext(level) {
  return CAT.xpLevels[Math.max(0, level - 1)] ?? null;
}

// Seal for floor N (N >= 2): 3,000 LM + 800 Bone, doubling each floor.
export function sealCost(floor) {
  if (floor < 2) return { lm: 0, bone: 0 };
  const f = 2 ** (floor - 2);
  return { lm: 3000 * f, bone: 800 * f };
}

export function chestPrice(state, chestId) {
  return state?.prices?.chests?.[chestId] ?? null;
}

// Pets: Lv 1-10, XP for level L = (L-1)^2.2 * 2500, 1 Bone = 10 pet XP (+1 $LM), +10% bonus per level.
export const PET_MAX_LEVEL = 10;
export const PET_XP_PER_BONE = 10;
export const petLevelXp = (l) => (l <= 1 ? 0 : Math.round((l - 1) ** 2.2 * 2500));
export function petProgress(xp = 0) {
  let level = 1;
  while (level < PET_MAX_LEVEL && xp >= petLevelXp(level + 1)) level++;
  const max = level >= PET_MAX_LEVEL;
  return {
    level, xp, max,
    into: max ? 0 : xp - petLevelXp(level),
    need: max ? 0 : petLevelXp(level + 1) - petLevelXp(level),
    boneToNext: max ? 0 : Math.ceil((petLevelXp(level + 1) - xp) / PET_XP_PER_BONE),
    boneToMax: Math.max(0, Math.ceil((petLevelXp(PET_MAX_LEVEL) - xp) / PET_XP_PER_BONE)),
  };
}
export function petBonus(petId, level) {
  const p = petInfo(petId);
  const mul = 1 + (Math.max(1, Math.min(PET_MAX_LEVEL, level)) - 1) * 0.1;
  return Object.fromEntries(Object.entries(p.bonus || {}).map(([k, v]) => [k, v * mul]));
}
export const PET_ABILITY = { leafhopper: 'Lily Pad – heal', shellby: 'Shell Guard – blok hit berikutnya', craboulder: 'Boulder Toss – damage + stun', emberkit: 'Ember Bolt – bola api' };

export const SHOP_CHESTS = ['chest_common', 'chest_rare', 'chest_epic', 'chest_legendary', 'chest_mythic_weapon', 'chest_mythic_equipment'];
export const PET_CHESTS = ['common', 'epic', 'legendary', 'mythic'];
