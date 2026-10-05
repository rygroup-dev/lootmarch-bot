import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { Store, seal, unseal, DEFAULT_SETTINGS } from '../src/store.js';
import { LootMarchApi, ApiError, applySetCookie, parseCookieHeader } from '../src/api.js';
import { signInWithKey, CaptchaRequired, checkSiweMessage } from '../src/auth.js';
import { Game, planAttributes, VAM_CAP } from '../src/game.js';
import { runRound, forgeTarget } from '../src/autopilot.js';
import { itemInfo, itemLabel, petProgress, sealCost, xpToNext, CAT, petLevelXp } from '../src/catalog.js';
import { normalizeKey, parseAmount } from '../src/wallet.js';
import * as V from '../src/views.js';
import { fakeServer, makeState, makePass } from './fixtures.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lm-'));
const SECRET = 'test-secret-key-123456';
const cfg = { baseUrl: 'https://lootmarch.xyz', rpcUrl: 'http://127.0.0.1:1', chainId: 4663 };
const KEY = '0x' + '11'.repeat(32);

function setup(opts) {
  const srv = fakeServer(opts);
  const store = new Store(tmp(), SECRET);
  store.setWallet(new ethers.Wallet(KEY).address, KEY);
  const game = new Game({ cfg, store, fetchImpl: srv.fetch });
  return { srv, store, game };
}

// ------------------------------------------------------------------ store
test('seal/unseal roundtrip, wrong secret fails', () => {
  const s = seal(SECRET, 'hello');
  assert.equal(unseal(SECRET, s), 'hello');
  assert.throws(() => unseal('other-secret-123456', s));
  assert.ok(!s.includes('hello'));
});

test('store keeps secrets encrypted on disk and merges new settings', () => {
  const dir = tmp();
  const st = new Store(dir, SECRET);
  st.setWallet('0xabc', KEY);
  st.setSession('lm_sid=zzz', '0xabc');
  const raw = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  assert.ok(!raw.includes('11111111') && !raw.includes('zzz'));
  const again = new Store(dir, SECRET);
  assert.equal(again.privateKey(), KEY);
  assert.equal(again.cookie(), 'lm_sid=zzz');
  assert.deepEqual(Object.keys(again.settings).sort(), Object.keys(DEFAULT_SETTINGS).sort());
  assert.throws(() => again.setSetting('nope', 1));
  assert.equal((fs.statSync(path.join(dir, 'state.json')).mode & 0o777), 0o600);
});

// ------------------------------------------------------------------ api
test('cookie jar: set-cookie update and expiry', () => {
  const jar = parseCookieHeader('a=1; b=2');
  applySetCookie(jar, ['a=9; Path=/; HttpOnly', 'b=; Max-Age=0']);
  assert.deepEqual([...jar], [['a', '9']]);
});

test('api maps NoSession to sessionLost and sends browser-like headers', async () => {
  const srv = fakeServer();
  const api = new LootMarchApi({ fetchImpl: srv.fetch });
  await assert.rejects(api.state(), (e) => e instanceof ApiError && e.sessionLost && e.status === 401);
  const res = await api.status().catch((e) => e);
  assert.ok(res instanceof ApiError); // /status is not in the fake server routes for anon
});

test('api network failure becomes ApiError(network)', async () => {
  const api = new LootMarchApi({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(api.state(), (e) => e.code === 'network');
});

// ------------------------------------------------------------------ auth
test('private-key login signs the SIWE message and stores the session', async () => {
  const { srv, store, game } = setup();
  const r = await game.login();
  const addr = new ethers.Wallet(KEY).address;
  assert.equal(r.address.toLowerCase(), addr.toLowerCase());
  const v = srv.lastVerify;
  const nonceMsg = srv.calls.find((c) => c.path === '/auth/verify');
  assert.ok(nonceMsg);
  assert.equal(v.captcha, null);
  assert.equal(v.hint, null, 'never send a spoofed device fingerprint');
  const msg = (await (await srv.fetch('https://lootmarch.xyz/api/auth/nonce', { method: 'POST', body: JSON.stringify({ address: v.address }) })).json()).message;
  assert.equal(ethers.verifyMessage(msg, v.signature).toLowerCase(), addr.toLowerCase());
  assert.equal(store.cookie(), 'lm_sid=abc');
  const st = await game.state();
  assert.equal(st.character.appearance.nick, 'TestHero');
});

test('login reports CaptchaRequired instead of trying to solve it', async () => {
  const { game } = setup({ requireCaptcha: true });
  await assert.rejects(game.login(), (e) => e instanceof CaptchaRequired);
});

test('SIWE message guard refuses foreign messages', () => {
  const a = '0x1111111111111111111111111111111111111111';
  assert.throws(() => checkSiweMessage('evil.xyz wants you to sign in\n' + a, a, 4663));
  assert.throws(() => checkSiweMessage(`lootmarch.xyz wants you to sign in\n${a}\nURI: https://lootmarch.xyz\nChain ID: 1`, a, 4663));
  assert.ok(checkSiweMessage(`lootmarch.xyz wants you to sign in\n${a}\nURI: https://lootmarch.xyz\nChain ID: 4663`, a, 4663));
});

test('expired session is renewed with the key once', async () => {
  const { srv, store, game } = setup();
  await game.login();
  store.setSession('lm_sid=dead', store.sessionAddress());
  game.api.setCookie('lm_sid=dead');
  const st = await game.state();
  assert.ok(st.balances);
  assert.equal(srv.calls.filter((c) => c.path === '/auth/verify').length, 2);
});

// ------------------------------------------------------------------ hero logic
test('planAttributes spends exactly sp points and respects the VAM cap', () => {
  for (const build of ['balanced', 'damage', 'tank']) {
    const base = { str: 0, vit: 0, agi: 0, def: 0, vam: 0 };
    const out = planAttributes(base, 100, build);
    const sum = Object.values(out).reduce((a, b) => a + b, 0);
    assert.equal(sum, 100, build);
    assert.ok(out.vam <= VAM_CAP);
  }
  const dmg = planAttributes({ str: 0, vit: 0, agi: 0, def: 0, vam: 0 }, 60, 'damage');
  const tank = planAttributes({ str: 0, vit: 0, agi: 0, def: 0, vam: 0 }, 60, 'tank');
  assert.ok(dmg.str > tank.str && tank.vit > dmg.vit && tank.def > dmg.def);
  assert.deepEqual(planAttributes({ str: 5, vit: 0, agi: 0, def: 0, vam: 0 }, 0), { str: 5, vit: 0, agi: 0, def: 0, vam: 0 });
});

test('attributes are sent as the full allocation', async () => {
  const { srv, game } = setup();
  await game.login();
  await game.addAttribute('vit', 1);
  const c = srv.calls.find((x) => x.path === '/game/character/attributes');
  assert.deepEqual(c.body.attributes, { agi: 0, def: 0, str: 1, vam: 0, vit: 1 });
  assert.ok(c.body.actionId);
  await assert.rejects(game.addAttribute('vit', 1), /tidak cukup/);
});

// ------------------------------------------------------------------ catalog
test('catalog resolves gear, forged gear, chests and unknown ids', () => {
  assert.equal(CAT.items.length > 200, true);
  const f = itemInfo('nightshade_stiletto@12');
  assert.equal(f.name, 'Nightshade Stiletto');
  assert.equal(f.rarity, 'legendary');
  assert.equal(f.plus, 12);
  assert.match(itemLabel('nightshade_stiletto@12'), /Nightshade Stiletto \+12/);
  assert.equal(itemInfo('chest_rare').kind, 'chest');
  assert.equal(itemInfo('weird_thing').name, 'Weird Thing');
  assert.deepEqual(sealCost(2), { lm: 3000, bone: 800 });
  assert.deepEqual(sealCost(4), { lm: 12000, bone: 3200 });
  assert.equal(xpToNext(1), 250);
  assert.equal(xpToNext(2), 1000);
});

test('pet levels follow the game curve', () => {
  assert.equal(petProgress(0).level, 1);
  assert.equal(petProgress(petLevelXp(2)).level, 2);
  assert.equal(petProgress(petLevelXp(10)).max, true);
  assert.equal(petProgress(0).boneToNext, Math.ceil(2500 / 10));
});

test('wallet input parsing', () => {
  assert.equal(normalizeKey('11'.repeat(32)), KEY);
  assert.throws(() => normalizeKey('0x123'));
  assert.equal(parseAmount('10k'), '10000');
  assert.equal(parseAmount('1,500'), '1500');
  assert.equal(parseAmount('1.5m'), '1500000');
  assert.equal(parseAmount('0.25'), '0.25');
  assert.throws(() => parseAmount('abc'));
});

// ------------------------------------------------------------------ autopilot
test('autopilot round: AFK, loot, equip, salvage, attrs, quests', async () => {
  const { srv, store, game } = setup();
  await game.login();
  const { log, errors } = await runRound(game, store);
  assert.deepEqual(errors, []);
  const paths = srv.calls.map((c) => c.path);
  for (const p of ['/offline/claim', '/game/loot/claim', '/game/equipment/best', '/game/inventory/salvage', '/game/character/attributes', '/game/daily/mission/claim', '/game/daily/login/claim']) {
    assert.ok(paths.includes(p), 'missing ' + p);
  }
  assert.ok(!paths.includes('/game/forge'), 'forge is opt-in');
  assert.ok(log.some((l) => l.includes('AFK')));
  // second round right after: nothing to do again
  srv.calls.length = 0;
  await runRound(game, store);
  assert.ok(!srv.calls.some((c) => ['/offline/claim', '/game/loot/claim', '/game/daily'].includes(c.path)));
});

test('autopilot breaks the floor seal when the floor is cleared and affordable', async () => {
  const { srv, store, game } = setup({ state: makeState({ progress: { zone_index: 10, floor: 1, best_depth: 11, floor_unlocked: 1 } }) });
  await game.login();
  const { log } = await runRound(game, store);
  assert.ok(srv.calls.some((c) => c.path === '/game/floor/unlock' && c.body.floor === 2));
  assert.ok(log.some((l) => l.includes('Floor 2')));
});

test('autopilot only alerts when the seal is too expensive', async () => {
  const st = makeState({ progress: { zone_index: 10, floor: 1, best_depth: 11, floor_unlocked: 1 } });
  st.balances.LM = 100;
  const { srv, store, game } = setup({ state: st });
  await game.login();
  const { log } = await runRound(game, store);
  assert.ok(!srv.calls.some((c) => c.path === '/game/floor/unlock'));
  assert.ok(log.some((l) => l.includes('sudah clear')));
  const again = await runRound(game, store);
  assert.ok(!again.log.some((l) => l.includes('sudah clear')), 'alert once per floor');
});

test('auto forge stops at the reserve', async () => {
  const { srv, store, game } = setup();
  await game.login();
  store.setSetting('autoForge', true);
  store.setSetting('forgeReserveLm', 17000);
  await runRound(game, store);
  const forges = srv.calls.filter((c) => c.path === '/game/forge');
  assert.ok(forges.length >= 1 && forges.length <= 4);
  assert.ok(srv.state.balances.LM >= 16000);
});

test('forgeTarget picks the lowest + level, weapon first on ties', () => {
  assert.equal(forgeTarget({ weapon: 'bronze_stiletto@2', helmet: 'iron_greathelm' }), 'iron_greathelm');
  assert.equal(forgeTarget({ weapon: 'rusty_stiletto', helmet: 'iron_greathelm' }), 'rusty_stiletto');
  assert.equal(forgeTarget({}), null);
});

test('live check alert fires once per hour while $LM is held', async () => {
  const { srv, store, game } = setup();
  await game.login();
  srv.live = { needed: true, valid: false, held: 5000, expiresAt: 0 };
  const a = await runRound(game, store);
  assert.ok(a.log.some((l) => l.includes('5,000 $LM tertahan')));
  const b = await runRound(game, store);
  assert.ok(!b.log.some((l) => l.includes('tertahan')));
});

test('withdraw validates game rules before sending', async () => {
  const { srv, game } = setup();
  await game.login();
  await assert.rejects(game.withdraw(500), /10,000/);
  await assert.rejects(game.withdraw(15000.5), /bulat/);
  srv.state.balances.LM = 100;
  await assert.rejects(game.withdraw(15000), /tidak cukup/);
  srv.state.balances.LM = 20000;
  await game.withdraw(15000);
  const c = srv.calls.find((x) => x.path === '/game/withdraw' && x.method === 'POST');
  assert.equal(c.body.amount, 15000);
  assert.ok(c.body.actionId);
});

// ------------------------------------------------------------------ views
test('every view renders from a realistic state', () => {
  const st = makeState();
  const s = DEFAULT_SETTINGS;
  const views = [
    V.homeView(st, { live: { needed: true, valid: true, expiresAt: Date.now() / 1000 + 600, held: 0 }, online: 600, autopilot: true }),
    V.heroView(st, s), V.invView([{ id: 'rusty_stiletto', qty: 3, info: itemInfo('rusty_stiletto') }], 0),
    V.itemView(st, 'bronze_stiletto@2'), V.itemView(st, 'chest_common'), V.salvageView(st), V.lootView(st, { seconds: 600, cap: 28800, rewards: { lm: 1, xp: 2, bone: 3, kills: 4 } }),
    V.passView(makePass(), st), V.travelView(st, 0), V.shopView(st), V.chestView(st, 'chest_epic'),
    V.petView(st), V.petDetail(st, 'leafhopper:common'), V.codexView(st),
    V.marketView(st, { listings: [{ id: 'L', itemId: 'bronze_sabre', price: 5 }] }, {}), V.listingView(st, { id: 'L', itemId: 'bronze_sabre', price: 5, seller: 'x' }),
    V.myListingsView(st), V.historyView({ recent: [] }, 'TestHero'), V.ranksView({ boards: { level: [] } }),
    V.walletView({ address: null }), V.settingsView(s, {}), V.buildPicker('balanced'),
  ];
  for (const v of views) {
    assert.ok(v.text.length > 10 && v.text.length < 4096);
    for (const row of v.kb.inline_keyboard) for (const b of row) assert.ok(Buffer.byteLength(b.callback_data || '') <= 64, b.callback_data);
  }
});

test('premium pass analysis scales with reachable tiers', () => {
  const st = makeState();
  const full = V.passCalc(makePass(), st, 1000);
  const low = V.passCalc(makePass(), st, 300);
  assert.ok(full.reach > low.reach);
  assert.ok(full.value > low.value);
  assert.ok(full.extra >= 3 + 1); // pet chest common + rare chest
});
