import crypto from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code || 'Request gagal');
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
  get sessionLost() { return this.status === 401 || this.code === 'NoSession'; }
}

// "a=1; b=2" <-> Map, so Set-Cookie updates replace single entries.
export function parseCookieHeader(str) {
  const jar = new Map();
  for (const part of String(str || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (k) jar.set(k, part.slice(i + 1).trim());
  }
  return jar;
}

export function applySetCookie(jar, setCookies) {
  for (const sc of setCookies || []) {
    const first = sc.split(';')[0];
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const k = first.slice(0, i).trim();
    const v = first.slice(i + 1).trim();
    const expired = /max-age=0/i.test(sc) || /expires=Thu, 01 Jan 1970/i.test(sc);
    if (expired || v === '') jar.delete(k); else jar.set(k, v);
  }
  return jar;
}

const cookieString = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const uuid = () => crypto.randomUUID();

export class LootMarchApi {
  constructor({ baseUrl = 'https://lootmarch.xyz', cookie = '', onCookie = null, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
    this.baseUrl = baseUrl;
    this.jar = parseCookieHeader(cookie);
    this.onCookie = onCookie;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  get cookie() { return cookieString(this.jar); }
  setCookie(str) { this.jar = parseCookieHeader(str); }

  async request(path, { method = 'GET', body } = {}) {
    const headers = {
      accept: '*/*',
      'user-agent': UA,
      origin: this.baseUrl,
      referer: this.baseUrl + '/play',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.jar.size) headers.cookie = this.cookie;
    let res;
    try {
      res = await this.fetch(this.baseUrl + '/api' + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ApiError(0, 'network', 'Server LootMarch tidak bisa dihubungi (' + (e.name === 'TimeoutError' ? 'timeout' : e.message) + ').');
    }
    const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (sc.length) {
      const before = this.cookie;
      applySetCookie(this.jar, sc);
      if (this.cookie !== before && this.onCookie) this.onCookie(this.cookie);
    }
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const msg = data?.message || (res.status === 403 && !data ? 'Diblokir Cloudflare (403).' : `HTTP ${res.status}`);
      throw new ApiError(res.status, data?.error || 'error', msg, { retryIn: data?.retryIn, data });
    }
    return data;
  }

  // Reads are safe to repeat: retry brief 5xx/network blips (the game returns 502 now and then).
  async get(p) {
    for (let i = 0; ; i++) {
      try { return await this.request(p); } catch (e) {
        const transient = e instanceof ApiError && (e.status === 0 || e.status >= 500);
        if (!transient || i >= 2) throw e;
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      }
    }
  }
  post(p, body = {}) { return this.request(p, { method: 'POST', body }); }

  // --- auth ---
  status() { return this.get('/status'); }
  captchaConfig() { return this.get('/auth/captcha'); }
  nonce(address) { return this.post('/auth/nonce', { address }); }
  verify({ address, signature, hint = null, captcha = null }) { return this.post('/auth/verify', { address, signature, hint, captcha }); }
  session() { return this.get('/auth/session'); }
  logout() { return this.post('/auth/logout', {}); }

  // --- state & progress ---
  state() { return this.get('/game/state'); }
  live() { return this.get('/game/live'); }
  daily() { return this.get('/game/daily'); }
  pass() { return this.get('/game/pass'); }
  leaderboard() { return this.get('/game/leaderboard'); }
  referral() { return this.get('/game/referral'); }
  feed(after = 0) { return this.get('/game/feed?after=' + (after | 0)); }
  waitlistReward() { return this.get('/game/waitlist-reward'); }
  startWaitlistReward() { return this.post('/game/waitlist-reward/start', {}); }

  // --- AFK & loot ---
  offlinePrepare() { return this.post('/offline/prepare', {}); }
  offlineClaim() { return this.post('/offline/claim', {}); }
  lootClaim() { return this.post('/game/loot/claim', {}); }

  // --- dungeon (travel / floors) ---
  travel(floor, zoneIndex) { return this.post('/game/run/travel', { floor, zoneIndex }); }
  unlockFloor(floor) { return this.post('/game/floor/unlock', { floor, actionId: uuid() }); }

  // --- hero ---
  // `attributes` = points to add per attribute, e.g. { str: 1, vit: 0, ... }.
  setAttributes(attributes) {
    const sorted = Object.fromEntries(Object.keys(attributes).sort().map((k) => [k, attributes[k]]));
    return this.post('/game/character/attributes', { attributes: sorted, actionId: uuid() });
  }

  selectClass(classId) { return this.post('/game/character/select', { classId, actionId: uuid() }); }
  setAppearance(appearance, nick) { return this.post('/game/character/appearance', { appearance, nick, actionId: uuid() }); }

  // --- gear ---
  equipBest() { return this.post('/game/equipment/best', { actionId: uuid() }); }
  equip(itemId) { return this.post('/game/equipment/equip', { itemId, actionId: uuid() }); }
  unequip(slot) { return this.post('/game/equipment/unequip', { slot, actionId: uuid() }); }
  forge(itemId, steps = 1) { return this.post('/game/forge', { itemId, actionId: uuid(), steps }); }
  // level = highest rarity index to break (0 common, 1 uncommon, 2 rare). One copy of each item stays.
  salvage(level) { return this.post('/game/inventory/salvage', { level, actionId: uuid() }); }
  destroy(itemId, qty = 1) { return this.post('/game/inventory/destroy', { itemId, qty, actionId: uuid() }); }

  // --- shop & chests ---
  buyChest(chestId, maxPrice) { return this.post('/game/chest/buy', { chestId, actionId: uuid(), maxPrice }); }
  openChest(chestId, heroWeapon) { return this.post('/game/chest/open', { chestId, actionId: uuid(), heroWeapon }); }
  buyBone(packs, maxPrice) { return this.post('/game/shop/bone', { packs, actionId: uuid(), maxPrice }); }
  openPetChest(chestType, maxPrice = null) {
    return this.post('/game/pet-chest/open', { chestType, actionId: uuid(), ...(maxPrice != null ? { maxPrice } : {}) });
  }

  // --- pets ---
  equipPet(petId) { return this.post('/game/pet/equip', { petId, actionId: uuid() }); }
  feedPet(petId, bone) { return this.post('/game/pet/feed', { petId, bone, actionId: uuid() }); }

  // --- quests & pass ---
  claimMission(dayKey, missionId) { return this.post('/game/daily/mission/claim', { dayKey, missionId }); }
  claimBoard(dayKey) { return this.post('/game/daily/board/claim', { dayKey }); }
  claimLogin() { return this.post('/game/daily/login/claim', {}); }
  claimPass() { return this.post('/game/pass/claim', {}); }
  buyPass(maxPrice) { return this.post('/game/pass/buy', { actionId: uuid(), maxPrice }); }

  // --- market ---
  market({ rarity = '', slot = '', page = 'all' } = {}) {
    const q = new URLSearchParams({ rarity, slot, page });
    return this.get('/game/market?' + q);
  }
  marketHistory() { return this.get('/game/market/history'); }
  marketList(itemId, price) { return this.post('/game/market/list', { itemId, price, actionId: uuid() }); }
  marketCancel(listingId) { return this.post('/game/market/cancel', { listingId, actionId: uuid() }); }
  marketBuy(listingId) { return this.post('/game/market/buy', { listingId, actionId: uuid() }); }

  // --- $LM in/out & ETH payments ---
  depositInfo() { return this.get('/game/deposit'); }
  depositClaim(txHash) { return this.post('/game/deposit/claim', { txHash }); }
  withdrawInfo() { return this.get('/game/withdraw'); }
  withdraw(amount) { return this.post('/game/withdraw', { amount, actionId: uuid() }); }
  ethQuote(product) { return this.post('/game/eth/quote', { product }); }
  ethClaim(quoteId, txHash) { return this.post('/game/eth/claim', { quoteId, txHash }); }
}
