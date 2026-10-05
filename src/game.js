import { LootMarchApi, ApiError } from './api.js';
import { WalletService, LM_TOKEN } from './wallet.js';
import { signInWithKey } from './auth.js';
import { itemInfo, RARITY_RANK, ZONES_PER_FLOOR, chestPrice } from './catalog.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const TRAVEL_COOLDOWN = 30 * 60;
export const SLIPPAGE = 0.03; // same 3% headroom the web client allows on $-priced items

export const ATTRS = ['str', 'vit', 'agi', 'def', 'vam'];
export const VAM_CAP = 20;
// Target share of points per build. Vampirism is filled first up to its cap on
// builds that use it: life steal is the only steady healing between rooms.
export const BUILDS = {
  balanced: { name: 'Seimbang', vamFirst: true, share: { str: 0.45, vit: 0.3, agi: 0.1, def: 0.15 } },
  damage: { name: 'Damage', vamFirst: true, share: { str: 0.65, vit: 0.2, agi: 0.15, def: 0 } },
  tank: { name: 'Tank', vamFirst: true, share: { str: 0.3, vit: 0.45, agi: 0, def: 0.25 } },
};

// Decide where `sp` free points go. Pure, so it is easy to test.
export function planAttributes(attrs, sp, buildId = 'balanced') {
  const build = BUILDS[buildId] || BUILDS.balanced;
  const next = { str: 0, vit: 0, agi: 0, def: 0, vam: 0, ...attrs };
  for (let i = 0; i < sp; i++) {
    if (build.vamFirst && next.vam < VAM_CAP && next.vam < Math.ceil(totalPoints(next) / 3)) { next.vam++; continue; }
    const spent = ATTRS.filter((a) => a !== 'vam').reduce((s, a) => s + next[a], 0) + 1;
    let best = null; let gap = -Infinity;
    for (const [a, share] of Object.entries(build.share)) {
      if (!share) continue;
      const g = share * spent - next[a];
      if (g > gap) { gap = g; best = a; }
    }
    if (!best) { if (next.vam < VAM_CAP) next.vam++; else next.str++; continue; }
    next[best]++;
  }
  return next;
}
const totalPoints = (a) => ATTRS.reduce((s, k) => s + (a[k] || 0), 0);

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
  }

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
    return this.act((a) => a.setAttributes({ ...c.attrs, [attr]: (c.attrs[attr] || 0) + n }));
  }

  async autoAttributes(buildId) {
    const st = await this.state();
    const c = st.character;
    if (!c?.sp) return null;
    const next = planAttributes(c.attrs, c.sp, buildId);
    await this.act((a) => a.setAttributes(next));
    return next;
  }

  equipBest() { return this.act((a) => a.equipBest()); }
  equip(itemId) { return this.act((a) => a.equip(itemId)); }
  unequip(slot) { return this.act((a) => a.unequip(slot)); }
  forge(itemId, steps = 1) { return this.act((a) => a.forge(itemId, steps)); }
  salvage(level) { return this.act((a) => a.salvage(level)); }

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
    if (!p.claimable) return null;
    return this.act((a) => a.claimPass());
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
  marketBuy(id) { return this.act((a) => a.marketBuy(id)); }

  // --- chain: deposit / withdraw / ETH payments ---------------------------
  depositInfo() { return this.call((a) => a.depositInfo()); }
  withdrawInfo() { return this.call((a) => a.withdrawInfo()); }

  async walletBalances() {
    const w = this.wallet();
    const addr = this.store.walletAddress();
    if (!addr) throw new Error('Wallet belum di-set.');
    let token = LM_TOKEN;
    try { token = (await this.depositInfo()).token || LM_TOKEN; } catch { /* use fallback */ }
    return { address: addr, token, ...(await w.balances(token, addr)) };
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
    const info = await this.depositInfo();
    if (!info.open) throw new Error('Deposit belum dibuka oleh game.');
    const w = this.wallet();
    onStep('kirim');
    const tx = await w.sendToken(info.token, info.treasury, amount, info.decimals ?? 18);
    onStep('tunggu', tx.hash);
    await w.wait(tx);
    onStep('kredit', tx.hash);
    const res = await this.pollUntilCredited((a) => a.depositClaim(tx.hash), 60);
    return { hash: tx.hash, res };
  }

  depositClaim(txHash) { return this.pollUntilCredited((a) => a.depositClaim(txHash), 20); }

  async withdraw(amount) {
    const info = await this.withdrawInfo();
    const n = Number(amount);
    if (!info.open) throw new Error('Withdraw belum dibuka oleh game.');
    if (!Number.isInteger(n)) throw new Error('Jumlah withdraw harus bilangan bulat.');
    if (n < info.min || n > info.max) throw new Error(`Withdraw harus ${info.min.toLocaleString('en-US')} – ${info.max.toLocaleString('en-US')} $LM.`);
    if (info.usedToday >= info.perDay) throw new Error('Jatah withdraw hari ini sudah dipakai (reset 00:00 UTC).');
    if ((info.held ?? 0) < info.holdMin) throw new Error(`Wallet harus memegang minimal ${info.holdMin.toLocaleString('en-US')} $LM on-chain.`);
    const st = await this.state();
    if ((st.balances?.LM || 0) < n) throw new Error('Saldo $LM di game tidak cukup.');
    return this.act((a) => a.withdraw(n));
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
