import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Secrets (private key, session cookie) are sealed with AES-256-GCM using a
// key derived from SECRET_KEY, so a leaked state.json alone is useless.
export function seal(secret, plaintext) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(secret, salt, 32);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return ['v1', salt, iv, c.getAuthTag(), body].map((b) => (typeof b === 'string' ? b : b.toString('base64'))).join('.');
}

export function unseal(secret, sealed) {
  const [v, salt, iv, tag, body] = String(sealed).split('.');
  if (v !== 'v1') throw new Error('Format data terenkripsi tidak dikenal.');
  const key = crypto.scryptSync(secret, Buffer.from(salt, 'base64'), 32);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
}

export const DEFAULT_SETTINGS = {
  autoAfk: true,          // claim AFK rewards
  afkHours: 4,            // ...once this many hours have piled up (server caps at 8)
  autoLoot: true,         // move room drops from the Loot chest into the bag
  autoEquip: true,        // run "Equip best" after new gear arrives
  autoAttr: true,         // spend attribute points on level up
  build: 'auto',          // attribute build, see BUILDS in game.js ('auto' = by class)
  autoSalvage: true,      // break spare gear into Bone (one copy of each item is always kept)
  salvageLevel: 0,        // highest rarity salvaged: 0 common, 1 uncommon, 2 rare (rarer spares are sold)
  autoSell: true,         // list spare gear above salvageLevel on the market
  autoChest: true,        // open chests / pet chests already owned (pass & quest rewards); free
  autoUpgrade: true,      // buy better gear from the market when it raises Power
  upgradeShare: 0.5,      // ...spending at most this share of the game $LM balance per round
  autoTravel: true,       // walk the hero onto a newly opened floor
  autoSeal: true,         // break the next floor seal once the floor is cleared and it is affordable
  autoForge: false,       // spends $LM + Bone, so it is opt-in
  forgeReserveLm: 5000,   // never forge below this much $LM
  forgeReserveBone: 200,  // ...or this much Bone
  autoDaily: true,        // claim finished missions, daily board and login streak
  autoPass: true,         // claim reached March Pass tiers
  alertLive: true,        // warn when $LM is held by the human check
  alertShare: true,       // daily reminder for the X "Share your run" quest
  alertDrops: false,      // announce every Legendary/Mythic drop in the game
  reports: true,          // short message after each autopilot round that did something
};

export class Store {
  constructor(dir, secret) {
    this.file = path.join(dir, 'state.json');
    this.secret = secret;
    fs.mkdirSync(dir, { recursive: true });
    this.data = { settings: { ...DEFAULT_SETTINGS }, session: null, wallet: null, cursor: {}, log: [], samples: [] };
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...raw, settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) } };
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get settings() { return this.data.settings; }
  setSetting(k, v) {
    if (!(k in DEFAULT_SETTINGS)) throw new Error('Setelan tidak dikenal: ' + k);
    this.data.settings[k] = v;
    this.save();
  }

  // --- wallet -----------------------------------------------------------
  hasWallet() { return !!this.data.wallet; }
  walletAddress() { return this.data.wallet?.address || null; }
  setWallet(address, privateKey) {
    this.data.wallet = { address, key: seal(this.secret, privateKey) };
    this.save();
  }
  privateKey() {
    if (!this.data.wallet) return null;
    return unseal(this.secret, this.data.wallet.key);
  }
  clearWallet() { this.data.wallet = null; this.save(); }

  // --- game session -----------------------------------------------------
  cookie() {
    if (!this.data.session?.cookie) return '';
    try { return unseal(this.secret, this.data.session.cookie); } catch { return ''; }
  }
  setSession(cookie, address) {
    this.data.session = { cookie: seal(this.secret, cookie), address: address || null, at: Date.now() };
    this.save();
  }
  sessionAddress() { return this.data.session?.address || null; }
  clearSession() { this.data.session = null; this.save(); }

  // --- activity log shown in the 📋 Log screen ---------------------------
  addLog(text, source = 'auto') {
    const log = this.data.log || (this.data.log = []);
    log.push({ at: Date.now(), source, text });
    if (log.length > 80) log.splice(0, log.length - 80);
    this.save();
  }
  logs(n = 25) { return (this.data.log || []).slice(-n).reverse(); }

  // --- small bookkeeping (alert de-dup, timers) -------------------------
  cursor(k, def = 0) { return this.data.cursor[k] ?? def; }
  setCursor(k, v) { this.data.cursor[k] = v; this.save(); }
}
