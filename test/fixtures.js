// Shapes copied from real responses, values made up.
export const ADDR = '0x1111111111111111111111111111111111111111';

export function makeState(over = {}) {
  return {
    prices: { lmUsd: 0.00004, chests: { chest_common: 2500, chest_rare: 25000, chest_epic: 75000, chest_legendary: 175000, chest_mythic_weapon: 2000000, chest_mythic_equipment: 2000000 }, bonePack: { bone: 100, lm: 500 } },
    balances: { Bone: 1000, Gem: 0, XP: 1277, LM: 20000 },
    items: { stiletto_rusty: 0, rusty_stiletto: 3, 'bronze_stiletto@2': 1, iron_greathelm: 2, chest_common: 1 },
    pendingLoot: { bone: 6, items: [], drops: 4 },
    equipped: { weapon: 'bronze_stiletto@2', helmet: 'iron_greathelm' },
    progress: { user_id: ADDR, zone_index: 2, floor: 1, fortune_until: 0, best_depth: 3, floor_travel_at: 0, floor_unlocked: 1, floor_gate: 0 },
    codex: { enemies: ['slime', 'orc'], bosses: [], items: ['rusty_stiletto'] },
    market: [],
    petChests: { common: 0, epic: 0, legendary: 0, mythic: 0 },
    petChestTestLm: { enabled: true, dev: false, balance: 20000, prices: { common: 75000, epic: 125000, legendary: 200000, mythic: 875000 } },
    lmStatus: 'LIVE',
    character: { userId: ADDR, classId: 'dagger', className: 'DAGGER', weapon: 3, appearance: { nick: 'TestHero' }, totalXp: 1277, level: 3, xp: 27, attrs: { str: 1, vit: 0, agi: 0, def: 0, vam: 0 }, sp: 1 },
    pets: { owned: [{ petId: 'leafhopper:common', xp: 3000 }], activePet: 'leafhopper:common', authority: 'SERVER_VERIFIED' },
    enhancements: {},
    ethPurchases: true,
    ...over,
  };
}

export const DAILY = {
  serverNow: 1791195039, dayKey: 20731, resetAt: 1791244800,
  missions: [
    { id: 'rooms_6', difficulty: 'easy', metric: 'rooms', target: 6, title: 'First Steps', description: 'Clear 6 dungeon rooms.', reward: { Bone: 70, XP: 90 }, progress: 6, complete: true, claimed: false },
    { id: 'xp_350', difficulty: 'easy', metric: 'xp', target: 350, title: 'Growing Stronger', description: 'Earn 350 XP.', reward: { Bone: 70, XP: 80 }, progress: 100, complete: false, claimed: false },
  ],
  board: { completed: 1, required: 4, reward: { Bone: 600, XP: 600 }, complete: false, claimed: false },
  login: { nextDay: 2, claimedToday: false, rewards: [] },
  community: { status: 'NOT_SUBMITTED' },
};

export function makePass(over = {}) {
  const tiers = Array.from({ length: 50 }, (_, i) => ({
    free: { bone: 100, claimed: false },
    premium: i === 14 ? { petChest: 'common', claimed: false } : i === 24 ? { item: 'chest_rare', claimed: false } : { lm: 15000, claimed: false },
  }));
  const now = Math.floor(Date.now() / 1000);
  return {
    season: { id: 1, name: 'Season I', start: now - 86400, end: now + 29 * 86400, claimUntil: now + 36 * 86400, active: true, ended: false },
    xp: 165, tier: 0, tierXp: 500, maxTier: 50, xpRules: { room: 5, roomDailyCap: 400, mission: 80, board: 200 },
    today: { rooms: 17, roomXp: 85 }, premium: null, premiumUsd: 20, premiumLmUsd: 30, premiumLmNow: 750000, premiumLmPrice: 500000,
    tiers, claimable: false, ethPurchases: true, ...over,
  };
}

// Minimal in-memory LootMarch server for fetch().
export function fakeServer({ state = makeState(), sessionCookie = 'lm_sid=abc', requireCaptcha = false } = {}) {
  const calls = [];
  const srv = { state, calls, live: { mode: 'monitor', needed: true, valid: true, expiresAt: 9e9, held: 0, ttl: 3600 }, daily: structuredClone(DAILY), pass: makePass(), loggedIn: false, wallet: null };
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  srv.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const cookie = init.headers?.cookie || '';
    calls.push({ method: init.method || 'GET', path, body, cookie });
    const authed = cookie.includes(sessionCookie);
    const wrap = (extra = {}) => json(200, { success: true, ...extra, state: srv.state });
    if (path === '/auth/nonce') {
      srv.wallet = body.address;
      return json(200, { message: `lootmarch.xyz wants you to sign in with your Ethereum account:\n${body.address}\n\nSign in to Lootmarch.\n\nURI: https://lootmarch.xyz\nVersion: 1\nChain ID: 4663\nNonce: 123\nIssued At: x` });
    }
    if (path === '/auth/verify') {
      if (requireCaptcha && !body.captcha) return json(400, { error: 'captcha', message: 'Complete the anti-bot check.' });
      srv.lastVerify = body;
      return json(200, { address: body.address, created: false }, { 'set-cookie': sessionCookie + '; Path=/; HttpOnly' });
    }
    if (!authed) return json(401, { error: 'NoSession', message: 'Please sign in with your wallet.' });
    switch (path) {
      case '/auth/session': return json(200, { address: srv.wallet || ADDR });
      case '/game/state': return json(200, srv.state);
      case '/game/live': return json(200, srv.live);
      case '/offline/prepare': return json(200, { seconds: 7200, rewards: { lm: 900, xp: 3000, bone: 100, kills: 600, items: [], basis: 'recent' }, cap: 28800 });
      case '/offline/claim': srv.state.balances.LM += 900; return wrap({ seconds: 7200, rewards: { lm: 900, xp: 3000, bone: 100, items: [] } });
      case '/game/loot/claim': srv.state.balances.Bone += srv.state.pendingLoot.bone; { const c = { bone: srv.state.pendingLoot.bone, items: 1 }; srv.state.pendingLoot = { bone: 0, items: [], drops: 0 }; return wrap({ claimed: c }); }
      case '/game/equipment/best': return wrap();
      case '/game/inventory/salvage': srv.state.items.rusty_stiletto = 1; srv.state.balances.Bone += 60; return wrap();
      case '/game/character/attributes': srv.state.character.attrs = body.attributes; srv.state.character.sp = 0; return wrap({ intent: body.attributes });
      case '/game/forge': {
        srv.state.balances.LM -= 1000; srv.state.balances.Bone -= 100;
        const id = body.itemId; const [b, p = '0'] = id.split('@'); const nid = `${b}@${+p + body.steps}`;
        delete srv.state.items[id]; srv.state.items[nid] = 1;
        for (const [k, v] of Object.entries(srv.state.equipped)) if (v === id) srv.state.equipped[k] = nid;
        return wrap();
      }
      case '/game/floor/unlock': srv.state.balances.LM -= 3000; srv.state.balances.Bone -= 800; srv.state.progress.floor_unlocked = body.floor; return wrap();
      case '/game/daily': return json(200, srv.daily);
      case '/game/daily/mission/claim': srv.daily.missions.find((m) => m.id === body.missionId).claimed = true; return wrap();
      case '/game/daily/login/claim': srv.daily.login.claimedToday = true; return wrap();
      case '/game/daily/board/claim': srv.daily.board.claimed = true; return wrap();
      case '/game/pass': return json(200, srv.pass);
      case '/game/pass/claim': srv.pass.claimable = false; return wrap();
      case '/game/chest/buy': srv.state.balances.LM -= srv.state.prices.chests[body.chestId]; return wrap({ items: ['rusty_stiletto'] });
      case '/game/withdraw':
        if ((init.method || 'GET') === 'GET') return json(200, { min: 10000, max: 5000000, open: true, holdMin: 1000, perDay: 1, usedToday: 0, held: 5000, requests: [] });
        srv.state.balances.LM -= body.amount; return wrap({ request: { amount: body.amount } });
      case '/game/deposit': return json(200, { open: true, token: '0xa5c8cc9fbe4b41b383edb70348d28dd287c63e18', treasury: '0x2222222222222222222222222222222222222222', decimals: 18, recent: [] });
      case '/game/feed': return json(200, { last: 5, online: 100, events: [] });
      case '/game/leaderboard': return json(200, { boards: { deepest: [{ rank: 1, name: 'A', classId: 'wand', you: false, pass: true, depth: 5, floor: 1, zone: 5, region: 'Molten Depths' }], level: [{ rank: 1, name: 'TestHero', classId: 'dagger', you: true, level: 3 }] } });
      case '/game/market': return json(200, { listings: [{ id: 'L1', itemId: 'bronze_sabre', price: 400, at: 1, petXp: null, seller: 'X' }] });
      case '/game/market/history': return json(200, { recent: [] });
      default: return json(404, { error: 'NotFound', message: 'no route ' + path });
    }
  };
  return srv;
}
