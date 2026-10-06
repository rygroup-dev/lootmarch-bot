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
test('auto attributes send only the new points', async () => {
  const { srv, game } = setup();
  await game.login();
  srv.state.character.sp = 3;
  await game.autoAttributes('balanced');
  const c = srv.calls.find((x) => x.path === '/game/character/attributes');
  assert.equal(Object.values(c.body.attributes).reduce((a, b) => a + b, 0), 3);
  assert.equal(srv.state.character.sp, 0);
});

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

test('attributes are sent as points to add, like the web client', async () => {
  const { srv, game } = setup();
  await game.login();
  await game.addAttribute('vit', 1);
  const c = srv.calls.find((x) => x.path === '/game/character/attributes');
  assert.deepEqual(c.body.attributes, { agi: 0, def: 0, str: 0, vam: 0, vit: 1 });
  assert.equal(srv.state.character.attrs.vit, 1);
  assert.equal(srv.state.character.attrs.str, 1, 'existing points untouched');
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
  assert.ok(log.some((l) => l.includes('Chest dibuka') && l.includes('Steel Stiletto')), 'pass/quest chests are opened');
  for (const p of ['/offline/claim', '/game/loot/claim', '/game/chest/open', '/game/equipment/best', '/game/inventory/salvage', '/game/character/attributes', '/game/daily/mission/claim', '/game/daily/login/claim']) {
    assert.ok(paths.includes(p), 'missing ' + p);
  }
  assert.ok(!paths.includes('/game/forge'), 'forge is opt-in');
  assert.equal(srv.calls.find((c) => c.path === '/game/inventory/salvage').body.keep, 0, 'quick salvage: no copy kept');
  assert.ok(paths.includes('/game/inventory/destroy'), 'forged spare salvaged one by one');
  assert.ok(srv.state.items.steel_stiletto >= 1, 'rare spare is not salvaged');
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
  srv.state.equipped = { weapon: 'crystal_dirk@2', boots: 'mithril_sabatons' };
  await game.login();
  store.setSetting('autoForge', true);
  store.setSetting('forgeReserveLm', 17000);
  await runRound(game, store);
  const forges = srv.calls.filter((c) => c.path === '/game/forge');
  assert.ok(forges.length >= 1 && forges.length <= 4);
  assert.ok(srv.state.balances.LM >= 16000);
});

test('forge only keeper gear: epic+, legendary+ once the set is full legendary', async () => {
  const { forgeFloor } = await import('../src/autopilot.js');
  const EPIC = CAT.rarities.indexOf('epic'); const LEG = CAT.rarities.indexOf('legendary');
  const eq = { weapon: 'crystal_dirk@10', boots: 'mithril_sabatons', helmet: 'shadow_hood@6' };
  assert.equal(forgeFloor(eq), EPIC);
  assert.equal(forgeTarget(eq, forgeFloor(eq)), 'mithril_sabatons', 'rare hood skipped, lowest epic first');
  const legend = Object.fromEntries(CAT.slots.map((sl) => [sl, CAT.items.find((i) => i.slot === sl && i.rarity === 'legendary' && (sl !== 'weapon' || i.weaponType === 'dagger')).id]));
  assert.equal(forgeFloor(legend), LEG);
  legend.boots = 'mithril_sabatons';
  assert.equal(forgeFloor(legend), EPIC, 'one epic left: still epic floor');
  assert.equal(forgeTarget(legend, LEG) !== 'mithril_sabatons', true);
});

test('forgeTarget picks the lowest + level, weapon first on ties', () => {
  assert.equal(forgeTarget({ weapon: 'bronze_stiletto@2', helmet: 'iron_greathelm' }), 'iron_greathelm');
  assert.equal(forgeTarget({ weapon: 'rusty_stiletto', helmet: 'iron_greathelm' }), 'rusty_stiletto');
  assert.equal(forgeTarget({}), null);
});

test('live check alert fires once per hour while $LM is held', async () => {
  const { srv, store, game } = setup();
  await game.login();
  srv.live = { needed: true, valid: false, held: 0, expiresAt: 0 };
  assert.ok(!(await runRound(game, store)).log.some((l) => l.includes('Live check')), 'expired but nothing held: stay quiet');
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

test('build follows the class: ranged goes damage, melee balanced; caps hold', async () => {
  const { resolveBuild } = await import('../src/game.js');
  assert.equal(resolveBuild('auto', 'wand'), 'damage');
  assert.equal(resolveBuild('auto', 'dagger'), 'balanced');
  assert.equal(resolveBuild('tank', 'wand'), 'tank');
  const wand = planAttributes({}, 300, 'auto', 'wand');
  const dag = planAttributes({}, 300, 'auto', 'dagger');
  assert.ok(wand.str > dag.str && dag.vit > wand.vit);
  assert.ok(wand.agi <= 20 && wand.vam <= 20 && dag.agi <= 20);
  assert.equal(Object.values(wand).reduce((a, b) => a + b, 0), 300);
});

test('premium pass reminder fires once when tier 50 is reached', async () => {
  const { srv, store, game } = setup();
  await game.login();
  srv.pass = makePass({ tier: 50, xp: 25000 });
  const a = await runRound(game, store);
  assert.ok(a.log.some((l) => l.includes('Pass Premium')));
  store.setCursor('passAt', 0);
  const b = await runRound(game, store);
  assert.ok(!b.log.some((l) => l.includes('Pass Premium')));
});

test('GET retries a transient 502, POST does not', async () => {
  let n = 0;
  const api = new LootMarchApi({ fetchImpl: async (url, init) => {
    n++;
    if (n === 1 || init.method === 'POST') return new Response('bad gateway', { status: 502 });
    return new Response('{"ok":1}', { status: 200 });
  } });
  assert.deepEqual(await api.status(), { ok: 1 });
  assert.equal(n, 2);
  n = 10;
  await assert.rejects(api.lootClaim(), (e) => e.status === 502);
  assert.equal(n, 11);
});

test('market upgrade plan: right class, empty slots first, within budget', async () => {
  const { suggestUpgrades } = await import('../src/game.js');
  const srv = fakeServer();
  const st = srv.state;
  const plan = suggestUpgrades(st, srv.listings, st.balances.LM);
  const ids = plan.picks.map((p) => p.listing.id);
  assert.ok(ids.includes('L2'), 'cheap armor for the empty slot');
  assert.ok(!ids.includes('L1'), 'sabre is a sword, hero is a dagger');
  assert.ok(!ids.includes('L3') && !ids.includes('L4'));
  assert.ok(plan.spend <= st.balances.LM && plan.gain > 0);
  assert.deepEqual(suggestUpgrades(st, srv.listings, 10).picks, []);
});

test('pet ids with the market prefix resolve to the pet', async () => {
  const { petInfo, isPetId } = await import('../src/catalog.js');
  assert.equal(petInfo('pet:craboulder:rare').name, 'Rare Craboulder');
  assert.ok(isPetId('pet:craboulder:rare') && isPetId('leafhopper:common') && !isPetId('rusty_stiletto'));
});

test('nick rules follow the game', async () => {
  const { cleanNick, randomLook, LOOK } = await import('../src/catalog.js');
  assert.equal(cleanNick('  Ry  Hood '), 'Ry Hood');
  assert.equal(cleanNick('abcdefghijklm'), null);
  assert.equal(cleanNick('bad!'), null);
  const l = randomLook();
  assert.ok(LOOK.hairStyle.includes(l.hairStyle) && l.skin >= 1 && l.skin <= 6 && l.clothCol <= 8);
});

test('autopilot waits for a hero on a fresh account', async () => {
  const st = makeState(); st.character = { userId: '0x1' };
  const { srv, store, game } = setup({ state: st });
  await game.login();
  const r = await runRound(game, store);
  assert.ok(r.log[0].includes('belum punya hero'));
  assert.ok(!srv.calls.some((c) => c.path === '/offline/claim'));
});

test('upgrade planner skips poor-value buys', async () => {
  const { suggestUpgrades } = await import('../src/game.js');
  const st = makeState();
  // a common helmet already worn; a slightly better one for a lot of $LM is not worth it
  const plan = suggestUpgrades(st, [{ id: 'X', itemId: 'leather_hood', price: 5000 }], 20000);
  assert.equal(plan.picks.length, 0);
});

test('progress: room rate, active browser, stuck at a boss, day rollover', async () => {
  const { recordProgress } = await import('../src/autopilot.js');
  const store = new Store(tmp(), SECRET);
  const H = 3600e3; const t0 = Date.now() - 4 * H;
  let p;
  for (let i = 0; i <= 48; i++) p = recordProgress(store, { at: t0 + i * 5 * 60e3, rooms: i * 20, depth: 3, zone: 2, floor: 1 });
  assert.ok(Math.abs(p.roomsPerHour - 240) < 1);
  assert.ok(p.activeRecently && p.stuck && p.stuckRooms >= 120);
  p = recordProgress(store, { at: t0 + 49 * 5 * 60e3, rooms: 5, depth: 4, zone: 3, floor: 1 }); // past midnight + new region
  assert.ok(!p.stuck);
  assert.ok(store.data.samples.every((x, i, a) => i === 0 || x.rooms >= a[i - 1].rooms - 1e9));
});

test('captcha alert comes early while the browser is playing', async () => {
  const { srv, store, game } = setup();
  await game.login();
  const now = Date.now();
  store.data.samples = [{ at: now - 20 * 60e3, rooms: 10, depth: 3, zone: 2, floor: 1 }];
  srv.pass.today = { rooms: 60, roomXp: 300 };
  srv.live = { needed: true, valid: true, held: 0, expiresAt: Math.floor(now / 1000) + 120 };
  const a = await runRound(game, store);
  assert.ok(a.log.some((l) => l.includes('sebentar lagi muncul')));
  game.forget('pass');
  const b = await runRound(game, store);
  assert.ok(!b.log.some((l) => l.includes('Captcha')), 'once per expiry');
});

test('rare spare gear is listed just under the cheapest same item', async () => {
  const { srv, store, game } = setup();
  await game.login();
  store.setSetting('autoUpgrade', false);
  await runRound(game, store);
  const list = srv.calls.find((c) => c.path === '/game/market/list');
  assert.equal(list.body.itemId, 'steel_stiletto');
  assert.equal(list.body.price, 2999);
});

test('floor gate: seal is broken and the hero travels onto the new floor', async () => {
  const st = makeState({ progress: { zone_index: 10, floor: 1, best_depth: 10, floor_unlocked: 1, floor_gate: 2, floor_travel_at: 0 } });
  const { srv, store, game } = setup({ state: st });
  await game.login();
  const { log } = await runRound(game, store);
  assert.ok(srv.calls.some((c) => c.path === '/game/floor/unlock' && c.body.floor === 2));
  const tr = srv.calls.find((c) => c.path === '/game/run/travel');
  assert.deepEqual([tr.body.floor, tr.body.zoneIndex], [2, 0]);
  assert.ok(log.some((l) => l.includes('Travel ke')));
});

test('share nudge once per day, approval announced once', async () => {
  const { srv, store, game } = setup();
  await game.login();
  srv.daily.community = { status: 'NOT_SUBMITTED', xUsername: 'ry' };
  const a = await runRound(game, store);
  assert.ok(a.log.some((l) => l.includes('Share your run')));
  game.forget('daily');
  const b = await runRound(game, store);
  assert.ok(!b.log.some((l) => l.includes('Share your run')));
  srv.daily.community = { status: 'APPROVED', xUsername: 'ry' };
  game.forget('daily');
  const c2 = await runRound(game, store);
  assert.ok(c2.log.some((l) => l.includes('disetujui')));
});

test('market: uncommon listed with a slot kept for rare, sales reported', async () => {
  const { srv, store, game } = setup();
  await game.login();
  store.setSetting('autoUpgrade', false);
  store.setSetting('salvageLevel', 0);
  srv.state.items = { steel_stiletto: 1, frost_glaive: 1 };            // rare + uncommon spare (uncommon sold when salvageLevel is 0)
  srv.listings.push({ id: 'L6', itemId: 'frost_glaive', price: 900, at: 1, seller: 'Z' });
  srv.state.market = [1, 2, 3].map((i) => ({ id: 'old' + i, itemId: 'iron_sword', price: 50 }));
  await runRound(game, store);
  const lists = srv.calls.filter((c) => c.path === '/game/market/list').map((c) => c.body.itemId);
  assert.deepEqual(lists, ['steel_stiletto'], 'rare first; uncommon may not take the last free slot');
  assert.ok(srv.calls.some((c) => c.path === '/game/inventory/destroy' && c.body.itemId === 'frost_glaive'), 'uncommon without a slot is salvaged');
  srv.state.market = srv.state.market.filter((l) => l.id !== 'old1'); // old1 sold
  store.setCursor('lootAt', 0);
  const r = await runRound(game, store);
  assert.ok(r.log.some((l) => l.includes('Terjual') && l.includes('Iron Sword')));
});

test('stalled browser is reported once, then clears when rooms resume', async () => {
  const { recordProgress } = await import('../src/autopilot.js');
  const store = new Store(tmp(), SECRET);
  const M = 60e3; const t0 = Date.now() - 120 * M;
  let p;
  for (let i = 0; i <= 18; i++) p = recordProgress(store, { at: t0 + i * 5 * M, rooms: Math.min(i, 12) * 10, depth: 7, zone: 7, floor: 1 });
  assert.ok(p.stalled, 'rooms stopped for 30 min after being active');
  p = recordProgress(store, { at: t0 + 19 * 5 * M, rooms: 130, depth: 7, zone: 7, floor: 1 });
  assert.ok(!p.stalled && p.activeRecently);
  const quiet = new Store(tmp(), SECRET);
  for (let i = 0; i <= 18; i++) p = recordProgress(quiet, { at: t0 + i * 5 * M, rooms: 0, depth: 0, zone: 0, floor: 1 });
  assert.ok(!p.stalled, 'never active = AFK only, no alarm');
});

test('stale listings: uncommon pulled and salvaged, rare repriced under a cheaper rival', async () => {
  const { srv, store, game } = setup();
  await game.login();
  store.setSetting('autoUpgrade', false);
  const old = Math.floor(Date.now() / 1000) - 30 * 3600;
  srv.state.items = {};
  srv.state.market = [
    { id: 'u1', itemId: 'frost_glaive', price: 388, at: old },
    { id: 'r1', itemId: 'steel_stiletto', price: 9000, at: old },
  ];
  srv.listings.push({ id: 'c1', itemId: 'steel_stiletto', price: 4000, at: 1, seller: 'Rival' });
  const { log } = await runRound(game, store);
  assert.ok(srv.calls.some((c) => c.path === '/game/inventory/destroy' && c.body.itemId === 'frost_glaive'));
  const relist = srv.calls.filter((c) => c.path === '/game/market/list').map((c) => c.body);
  assert.deepEqual(relist, [{ itemId: 'steel_stiletto', price: 2999, actionId: relist[0].actionId }], 'one under the cheapest rival (3,000)');
  assert.ok(log.some((l) => l.includes('Harga disesuaikan')));
  assert.ok(!log.some((l) => l.includes('Terjual')), 'cancelled listings are not reported as sold');
});

test('forge running out of Bone is quiet, not an error', async () => {
  const { srv, store, game } = setup();
  await game.login();
  store.setSetting('autoForge', true);
  srv.state.equipped = { weapon: 'crystal_dirk@2' };
  const orig = srv.fetch;
  srv.fetch = async (url, init) => (String(url).endsWith('/game/forge') ? new Response(JSON.stringify({ error: 'NoBone', message: 'Not enough Bone.' }), { status: 400 }) : orig(url, init));
  game.api.fetch = srv.fetch;
  const { errors } = await runRound(game, store);
  assert.ok(!errors.some((e) => e.includes('Forge')), errors.join('|'));
});
