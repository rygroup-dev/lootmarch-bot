import { LootMarchApi, ApiError } from './api.js';
import { WalletService, LM_TOKEN } from './wallet.js';
import { ethers } from 'ethers';
const fmtUnitsRaw = (v) => ethers.formatUnits(v, 18);
import { signInWithKey } from './auth.js';
import { itemInfo, RARITY_RANK, ZONES_PER_FLOOR, chestPrice, heroPower, canWear, isPetId, CAT } from './catalog.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const TRAVEL_COOLDOWN = 30 * 60;
export const SLIPPAGE = 0.03; // same 3% headroom the web client allows on $-priced items

export const ATTRS = ['str', 'vit', 'agi', 'def', 'vam'];
export const VAM_CAP = 20;
// Every class has the same base stats and the same attribute effects; only the
// weapon skill differs. The game's own Power score values one point at roughly
// STR 13 · VIT 6.4 · DEF 5 · VAM 3.75 · AGI 1.2, so STR leads every build.
// Ranged classes (wand, spear) take fewer hits and can go harder on damage;
// melee classes stand in the crowd and want more HP. AGI only adds boss-slam
// dodge (capped at 50%, i.e. 20 points) and a little speed.
export const BUILDS = {
  auto: { name: 'Otomatis (per class)' },
  balanced: { name: 'Seimbang', share: { str: 0.45, vit: 0.25, vam: 0.15, def: 0.1, agi: 0.05 } },
  damage: { name: 'Damage', share: { str: 0.6, vam: 0.15, vit: 0.15, agi: 0.1 } },
  tank: { name: 'Tank', share: { vit: 0.4, str: 0.3, def: 0.2, vam: 0.1 } },
};
export const CLASS_BUILD = { wand: 'damage', spear: 'damage', sword: 'balanced', axe: 'balanced', dagger: 'balanced' };
export const ATTR_CAP = { vam: VAM_CAP, agi: 20 };

export function resolveBuild(buildId, classId) {
  if (buildId === 'auto' || !BUILDS[buildId]?.share) return CLASS_BUILD[classId] || 'balanced';
  return buildId;
}

// Decide where `sp` free points go. Pure, so it is easy to test.
export function planAttributes(attrs, sp, buildId = 'auto', classId = null) {
  const build = BUILDS[resolveBuild(buildId, classId)];
  const next = { str: 0, vit: 0, agi: 0, def: 0, vam: 0, ...attrs };
  for (let i = 0; i < sp; i++) {
    const total = ATTRS.reduce((t, k) => t + next[k], 0) + 1;
    let best = 'str'; let gap = -Infinity;
    for (const [a, share] of Object.entries(build.share)) {
      if (!share || next[a] >= (ATTR_CAP[a] ?? Infinity)) continue;
      const g = share * total - next[a];
      if (g > gap) { gap = g; best = a; }
    }
    next[best]++;
  }
  return next;
}

// The server takes the points to ADD per attribute (the web client's allocate()), not the totals.
export function attrDelta(from, to) {
  return Object.fromEntries(ATTRS.map((k) => [k, Math.max(0, (to[k] || 0) - (from[k] || 0))]));
}

// Equip policy: per slot the highest rarity wins (a forged epic outgrows a
// rare, +8 % vs +6 % per level), then the higher Power. Pure; returns the
// item ids to equip, one per slot that should change.
export function planEquip(st) {
  const rank = (id) => RARITY_RANK[itemInfo(id).rarity] ?? 0;
  const out = [];
  for (const slot of CAT.slots) {
    const cur = st.equipped?.[slot] || null;
    let best = cur; let bestPow = cur ? heroPower(st) : -1;
    for (const [id, q] of Object.entries(st.items || {})) {
      if (!q || itemInfo(id).slot !== slot || !canWear(st, id)) continue;
      const pow = heroPower(st, { ...(st.equipped || {}), [slot]: id });
      const better = !best || rank(id) > rank(best) || (rank(id) === rank(best) && pow > bestPow);
      if (better) { best = id; bestPow = pow; }
    }
    if (best && best !== cur) out.push(best);
  }
  return out;
}

export const MARKET_BUY_FEE = 0.05;
// Skip poor buys: an upgrade must add 2% Power, and every step up must be
// worth at least 1 Power per 100 $LM (good market buys run 0.03-0.1 per $LM).
export const MIN_GAIN_SHARE = 0.02;
export const MIN_POWER_PER_LM = 0.01;

// Pick at most one listing per slot to maximise Power within the budget.
// Start with each slot's best value buy, then keep stepping a slot up to a
// stronger listing while the extra Power per extra $LM stays worthwhile.
export function suggestUpgrades(st, listings, budget) {
  const base = heroPower(st);
  const cands = new Map(); // slot -> [{listing, cost, gain}]
  for (const l of listings || []) {
    if (isPetId(l.itemId) || !canWear(st, l.itemId)) continue;
    const info = itemInfo(l.itemId);
    const worn = st.equipped?.[info.slot];
    // never buy below the rarity already worn in that slot (it would be swapped back out)
    if (worn && (RARITY_RANK[info.rarity] ?? 0) < (RARITY_RANK[itemInfo(worn).rarity] ?? 0)) continue;
    const cost = Math.ceil(l.price * (1 + MARKET_BUY_FEE));
    const gain = heroPower(st, { ...(st.equipped || {}), [info.slot]: l.itemId }) - base;
    if (gain < Math.max(1, base * MIN_GAIN_SHARE) || gain / cost < MIN_POWER_PER_LM || cost > budget) continue;
    (cands.get(info.slot) || cands.set(info.slot, []).get(info.slot)).push({ slot: info.slot, listing: l, cost, gain });
  }
  // first pass: best value per slot, best slots first
  const firsts = [...cands.values()].map((a) => a.reduce((x, y) => (y.gain / y.cost > x.gain / x.cost ? y : x)))
    .sort((a, b) => b.gain / b.cost - a.gain / a.cost);
  const chosen = new Map(); let left = budget;
  for (const p of firsts) if (p.cost <= left) { chosen.set(p.slot, p); left -= p.cost; }
  // then upgrades: the best marginal step across all slots, repeatedly
  for (;;) {
    let best = null;
    for (const [slot, cur] of chosen) {
      for (const c of cands.get(slot)) {
        const dc = c.cost - cur.cost; const dg = c.gain - cur.gain;
        if (dg <= 0 || dc > left) continue;
        const r = dc <= 0 ? Infinity : dg / dc;
        if (r >= MIN_POWER_PER_LM && (!best || r > best.r)) best = { slot, c, dc, r };
      }
    }
    if (!best) break;
    chosen.set(best.slot, best.c); left -= best.dc;
  }
  const picks = [...chosen.values()].map((p) => ({ ...p, ratio: p.gain / p.cost })).sort((a, b) => b.gain - a.gain);
  return { picks, spend: budget - left, gain: picks.reduce((t, p) => t + p.gain, 0), base };
}

export function depth(floor, zoneIndex) { return (floor - 1) * ZONES_PER_FLOOR + zoneIndex + 1; }

export class Game {
  constructor({ cfg, store, fetchImpl, provider } = {}) {
    this.cfg = cfg;
    this.store = store;
    this.api = new LootMarchApi({
      baseUrl: cfg.baseUrl,
      cookie: store.cookie(),
      fetchImpl,
      onCookie: (c) => store.setSession(c, store.sessionAddress()),
    });
    this.provider = provider;
    this.last = null;      // last /game/state
    this.lastAt = 0;
    this.busy = Promise.resolve();
    this.reloginAt = 0;
    this.cache = new Map(); // key -> { at, p }
  }

  // Small TTL cache for slow, rarely-changing reads (the game API takes 0.5-2 s per call).
  cached(key, ttlMs, fn) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.p;
    const p = fn().catch((e) => { this.cache.delete(key); throw e; });
    this.cache.set(key, { at: Date.now(), p });
    return p;
  }
  forget(key) { this.cache.delete(key); }

  wallet() {
    const key = this.store.privateKey();
    return new WalletService({ rpcUrl: this.cfg.rpcUrl, chainId: this.cfg.chainId, privateKey: key, provider: this.provider });
  }

  // Serialise every game write: the server keys actions by actionId and the
  // web client never fires two at once either.
  lock(fn) {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => {});
    return run;
  }

  // --- session ------------------------------------------------------------
  async login() {
    const w = this.wallet();
    if (!w.signer) throw new Error('Private key belum di-set. Buka 💰 Wallet → 🔑 Import key.');
    this.api.setCookie('');
    const res = await signInWithKey(this.api, w, this.cfg.chainId);
    this.store.setSession(this.api.cookie, res.address);
    return res;
  }

  // No session yet but a key is stored: just sign in. Callers never deal with sessions.
  async ensureSession() {
    if (this.store.data.session) return true;
    if (!this.store.hasWallet()) return false;
    if (Date.now() - this.reloginAt < 60000) return false;
    this.reloginAt = Date.now();
    await this.login();
    return true;
  }

  async useCookie(cookie) {
    this.api.setCookie(cookie);
    const s = await this.api.session();
    if (!s?.address) throw new Error('Cookie tidak valid / sudah expired.');
    const w = this.store.walletAddress();
    if (w && w.toLowerCase() !== s.address.toLowerCase()) {
      throw new Error(`Cookie ini milik ${s.address}, bukan wallet bot (${w}).`);
    }
    this.store.setSession(this.api.cookie, s.address);
    return s.address;
  }

  async logout() {
    try { await this.api.logout(); } catch { /* already gone */ }
    this.api.setCookie('');
    this.store.clearSession();
  }

  // Run an API call; if the session died, sign in again with the key once.
  async call(fn) {
    try {
      return await fn(this.api);
    } catch (e) {
      if (!(e instanceof ApiError) || !e.sessionLost) throw e;
      if (!this.store.hasWallet() || Date.now() - this.reloginAt < 60000) {
        throw new Error('Session login habis. Tekan 🔐 Login ulang di menu ⚙️.');
      }
      this.reloginAt = Date.now();
      await this.login();
      return fn(this.api);
    }
  }

  keep(res) {
    const st = res?.state && typeof res.state === 'object' ? res.state : null;
    if (st) { this.last = st; this.lastAt = Date.now(); }
    return res;
  }

  async state(maxAgeMs = 0) {
    if (this.last && Date.now() - this.lastAt < maxAgeMs) return this.last;
    const st = await this.call((a) => a.state());
    this.last = st; this.lastAt = Date.now();
    return st;
  }

  act(fn) { return this.lock(async () => this.keep(await this.call(fn))); }

  // --- loot & AFK ---------------------------------------------------------
  afkPreview() { return this.call((a) => a.offlinePrepare()); }
  afkClaim() { return this.act((a) => a.offlineClaim()); }
  lootClaim() { return this.act((a) => a.lootClaim()); }

  // --- hero ---------------------------------------------------------------
  async addAttribute(attr, n = 1) {
    const st = await this.state();
    const c = st.character;
    if (!ATTRS.includes(attr)) throw new Error('Attribute tidak dikenal.');
    if ((c.sp || 0) < n) throw new Error('Attribute point tidak cukup.');
    if (attr === 'vam' && (c.attrs.vam || 0) + n > VAM_CAP) throw new Error(`Vampirism maksimal ${VAM_CAP} poin.`);
    return this.act((a) => a.setAttributes(attrDelta({}, { [attr]: n })));
  }

  async autoAttributes(buildId) {
    const st = await this.state();
    const c = st.character;
    if (!c?.sp) return null;
    const next = planAttributes(c.attrs, c.sp, buildId, c.classId);
    await this.act((a) => a.setAttributes(attrDelta(c.attrs, next)));
    return next;
  }

  // A fresh account has no hero yet: the web client asks for a class, then look + name.
  needsHero(st = this.last) { return !st?.character?.classId || !st?.character?.appearance?.nick; }
  async createHero(classId, nick, look) {
    const st = await this.state();
    if (!st.character?.classId || st.character.classId !== classId) await this.act((a) => a.selectClass(classId));
    await this.act((a) => a.setAppearance(look, nick));
    return this.state();
  }

  // Apply the configured referral code once, only if the server still allows it (new accounts).
  async applyReferral() {
    const code = this.cfg.referralCode;
    if (!code || !/^[A-Z0-9]{4,12}$/.test(code) || this.store.cursor('refApplied')) return null;
    const r = await this.call((a) => a.referral());
    if (!r?.canBind || r.referrer || r.code === code) { this.store.setCursor('refApplied', 1); return null; }
    await this.call((a) => a.bindReferral(code));
    this.store.setCursor('refApplied', 1);
    return { code, bonus: r.welcomeBonus };
  }

  equipBest() { return this.act((a) => a.equipBest()); }
  equip(itemId) { return this.act((a) => a.equip(itemId)); }
  unequip(slot) { return this.act((a) => a.unequip(slot)); }
  forge(itemId, steps = 1) { return this.act((a) => a.forge(itemId, steps)); }
  salvage(level, keep) { return this.act((a) => a.salvage(level, keep)); }
  // salvage one specific item (also works for forged copies); pays Bone like the web client
  salvageOne(itemId) { return this.act((a) => a.destroy(itemId, 1)); }

  // --- travel -------------------------------------------------------------
  travelReadyIn(st = this.last) {
    const at = st?.progress?.floor_travel_at || 0;
    return Math.max(0, at + TRAVEL_COOLDOWN - Math.floor(Date.now() / 1000));
  }
  travel(floor, zone) { return this.act((a) => a.travel(floor, zone)); }
  unlockFloor(floor) { return this.act((a) => a.unlockFloor(floor)); }

  // --- quests & pass ------------------------------------------------------
  daily() { return this.call((a) => a.daily()); }
  pass() { return this.call((a) => a.pass()); }

  async claimDailyAll() {
    const d = await this.daily();
    const got = [];
    for (const m of d.missions || []) {
      if (m.complete && !m.claimed) { await this.act((a) => a.claimMission(d.dayKey, m.id)); got.push(m.title); }
    }
    const d2 = got.length ? await this.daily() : d;
    if (d2.board?.complete && !d2.board.claimed) { await this.act((a) => a.claimBoard(d2.dayKey)); got.push('Daily reward'); }
    if (d2.login && !d2.login.claimedToday) { await this.act((a) => a.claimLogin()); got.push('Login streak'); }
    return got;
  }

  async claimPassIfAny() {
    const p = await this.pass();
    const claimed = p.claimable ? await this.act((a) => a.claimPass()) : null;
    return { pass: p, claimed };
  }

  // --- shop ---------------------------------------------------------------
  async buyChest(chestId) {
    const st = await this.state();
    const price = chestPrice(st, chestId);
    if (!price) throw new Error('Harga chest belum tersedia.');
    if ((st.balances?.LM || 0) < price) throw new Error(`$LM kurang: butuh ${price.toLocaleString('en-US')}.`);
    return this.act((a) => a.buyChest(chestId, Math.ceil(price * (1 + SLIPPAGE))));
  }
  async openChest(chestId) {
    const st = await this.state();
    return this.act((a) => a.openChest(chestId, st.character?.weapon));
  }
  async openPetChest(type) {
    const st = await this.state();
    const owned = st.petChests?.[type] || 0;
    const price = owned > 0 ? null : st.petChestTestLm?.prices?.[type];
    if (!owned && !price) throw new Error('Pet chest ini belum bisa dibeli dengan $LM.');
    return this.act((a) => a.openPetChest(type, price ? Math.ceil(price * (1 + SLIPPAGE)) : null));
  }
  async buyBone(packs) {
    const st = await this.state();
    const per = st.prices?.bonePack?.lm;
    if (!per) throw new Error('Harga bone pack belum tersedia.');
    return this.act((a) => a.buyBone(packs, Math.ceil(per * packs * (1 + SLIPPAGE))));
  }

  // --- pets ---------------------------------------------------------------
  equipPet(petId) { return this.act((a) => a.equipPet(petId)); }
  feedPet(petId, bone) { return this.act((a) => a.feedPet(petId, bone)); }

  // --- market -------------------------------------------------------------
  market(q) { return this.call((a) => a.market(q)); }
  marketHistory() { return this.call((a) => a.marketHistory()); }
  marketList(itemId, price) { return this.act((a) => a.marketList(itemId, price)); }
  marketCancel(id) { return this.act((a) => a.marketCancel(id)); }
  marketBuy(id) { this.forget('market:all'); return this.act((a) => a.marketBuy(id)); }

  async upgradePlan(budget) {
    const [st, { listings }] = await Promise.all([this.state(20000), this.cached('market:all', 30000, () => this.market({}))]);
    return suggestUpgrades(st, listings, Math.min(budget ?? Infinity, st.balances?.LM || 0));
  }

  // Buy each pick and wear it. Stops at the first failure (sold out, price moved).
  async buyUpgrades(picks) {
    const done = []; const failed = [];
    for (const p of picks) {
      try {
        await this.marketBuy(p.listing.id);
        await this.equip(p.listing.itemId).catch(() => {});
        done.push(p);
      } catch (e) { failed.push({ ...p, error: e.message }); }
    }
    return { done, failed };
  }

  // --- chain: deposit / withdraw / ETH payments ---------------------------
  depositInfo() { return this.cached('deposit', 10 * 60000, () => this.call((a) => a.depositInfo())); }
  withdrawInfo(fresh = false) {
    if (fresh) this.forget('withdraw');
    return this.cached('withdraw', 60000, () => this.call((a) => a.withdrawInfo()));
  }
  hold(ttl = 10 * 60000) { return this.cached('hold', ttl, () => this.call((a) => a.hold())); }

  // Refuse wallet moves that would drop the on-chain $LM below the dungeon hold.
  async assertHoldAfter(spendLm) {
    let h = null;
    try { h = await this.hold(0); } catch { return; } // unknown: let the server decide
    if (!h?.required) return;
    const b = await this.walletBalances();
    const left = Number(fmtUnitsRaw(b.lm)) - Number(spendLm);
    if (left < h.required) {
      throw new Error(`Ditolak: sisa $LM di wallet jadi ${Math.floor(left).toLocaleString('en-US')}, padahal game mewajibkan hold minimal ${h.required.toLocaleString('en-US')} $LM untuk masuk dungeon.`);
    }
  }

  live(ttl = 60000) { return this.cached('live', ttl, () => this.call((a) => a.live())); }
  online() { return this.cached('feed', 60000, () => this.api.feed(0)).then((f) => f.online).catch(() => null); }

  async walletBalances() {
    const w = this.wallet();
    const addr = this.store.walletAddress();
    if (!addr) throw new Error('Wallet belum di-set.');
    let token = LM_TOKEN;
    try { token = (await this.depositInfo()).token || LM_TOKEN; } catch { /* use fallback */ }
    return this.cached('bal:' + addr, 15000, async () => ({ address: addr, token, ...(await w.balances(token, addr)) }));
  }

  async pollUntilCredited(fn, tries, onTick) {
    for (let i = 0; i < tries; i++) {
      let res = null;
      try { res = await this.call(fn); } catch (e) {
        if (e instanceof ApiError && e.status && e.status < 500) throw e;
      }
      if (res && !res.pending) return this.keep(res);
      if (onTick) onTick(i);
      await sleep(3000);
    }
    throw new Error('Masih menunggu konfirmasi. Coba "Klaim pakai tx hash" beberapa menit lagi.');
  }

  async deposit(amount, onStep = () => {}) {
    await this.assertHoldAfter(amount);
    const info = await this.depositInfo();
    if (!info.open) throw new Error('Deposit belum dibuka oleh game.');
    const w = this.wallet();
    onStep('kirim');
    const tx = await w.sendToken(info.token, info.treasury, amount, info.decimals ?? 18);
    onStep('tunggu', tx.hash);
    await w.wait(tx);
    this.cache.clear();
    onStep('kredit', tx.hash);
    const res = await this.pollUntilCredited((a) => a.depositClaim(tx.hash), 60);
    return { hash: tx.hash, res };
  }

  depositClaim(txHash) { return this.pollUntilCredited((a) => a.depositClaim(txHash), 20); }

  async withdraw(amount) {
    const info = await this.withdrawInfo(true);
    const n = Number(amount);
    if (!info.open) throw new Error('Withdraw belum dibuka oleh game.');
    if (!Number.isInteger(n)) throw new Error('Jumlah withdraw harus bilangan bulat.');
    if (n < info.min || n > info.max) throw new Error(`Withdraw harus ${info.min.toLocaleString('en-US')} – ${info.max.toLocaleString('en-US')} $LM.`);
    if (info.usedToday >= info.perDay) throw new Error('Jatah withdraw hari ini sudah dipakai (reset 00:00 UTC).');
    if ((info.held ?? 0) < info.holdMin) throw new Error(`Wallet harus memegang minimal ${info.holdMin.toLocaleString('en-US')} $LM on-chain.`);
    const st = await this.state();
    if ((st.balances?.LM || 0) < n) throw new Error('Saldo $LM di game tidak cukup.');
    const res = await this.act((a) => a.withdraw(n));
    this.forget('withdraw');
    return res;
  }

  // product: chest id, pet chest, or "march_pass"
  async payWithEth(product, onStep = () => {}) {
    const q = await this.call((a) => a.ethQuote(product));
    onStep('quote', q);
    const w = this.wallet();
    const tx = await w.sendWei(q.to, q.wei);
    onStep('tunggu', tx.hash);
    await w.wait(tx);
    const res = await this.pollUntilCredited((a) => a.ethClaim(q.quoteId, tx.hash), 120);
    return { hash: tx.hash, quote: q, res };
  }

  async send(kind, to, amount) {
    if (kind !== 'eth') await this.assertHoldAfter(amount);
    this.cache.clear();
    const w = this.wallet();
    if (kind === 'eth') return w.sendEth(to, amount);
    let token = LM_TOKEN;
    try { token = (await this.depositInfo()).token || LM_TOKEN; } catch { /* fallback */ }
    return w.sendToken(token, to, amount, 18);
  }

  // --- helpers for the UI -------------------------------------------------
  inventory(st = this.last) {
    const out = [];
    for (const [id, qty] of Object.entries(st?.items || {})) {
      if (!qty || id === 'bone') continue;
      out.push({ id, qty, info: itemInfo(id) });
    }
    out.sort((a, b) => (RARITY_RANK[b.info.rarity] ?? 0) - (RARITY_RANK[a.info.rarity] ?? 0) || (b.info.plus - a.info.plus) || a.info.name.localeCompare(b.info.name));
    return out;
  }
}
