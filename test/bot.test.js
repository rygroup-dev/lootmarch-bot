import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { Store } from '../src/store.js';
import { Game } from '../src/game.js';
import { createBot } from '../src/bot.js';
import { fakeServer } from './fixtures.js';

const OWNER = 42;
const KEY = '0x' + '22'.repeat(32);

async function harness() {
  const srv = fakeServer();
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'lmb-')), 'test-secret-key-123456');
  store.setWallet(new ethers.Wallet(KEY).address, KEY);
  const cfg = { botToken: '1:test', ownerIds: [OWNER], baseUrl: 'https://lootmarch.xyz', rpcUrl: 'http://127.0.0.1:1', chainId: 4663, explorer: 'https://x' };
  const game = new Game({ cfg, store, fetchImpl: srv.fetch });
  await game.login();
  const bot = createBot({ cfg, store, game });
  bot.botInfo = { id: 1, is_bot: true, first_name: 'b', username: 'b', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
  const sent = [];
  let mid = 100;
  bot.api.config.use(async (prev, method, payload) => {
    sent.push({ method, payload });
    const msg = { message_id: ++mid, date: 0, chat: { id: OWNER, type: 'private' }, text: payload.text || '' };
    return { ok: true, result: method === 'answerCallbackQuery' || method === 'deleteMessage' ? true : msg };
  });
  let uid = 1;
  const from = { id: OWNER, is_bot: false, first_name: 'o' };
  const chat = { id: OWNER, type: 'private' };
  const text = (t, who = from) => bot.handleUpdate({ update_id: uid++, message: { message_id: uid, date: 0, chat, from: who, text: t, ...(t.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: t.split(' ')[0].length }] } : {}) } });
  const press = (data) => bot.handleUpdate({ update_id: uid++, callback_query: { id: String(uid), from, chat_instance: 'c', data, message: { message_id: 5, date: 0, chat, from: { id: 1, is_bot: true, first_name: 'b' }, text: 'x' } } });
  const errors = () => sent.filter((s) => /⚠️/.test(s.payload.text || '') || /⚠️/.test(s.payload.text || ''));
  const lastText = () => [...sent].reverse().find((s) => s.payload.text)?.payload.text || '';
  return { srv, store, game, bot, sent, text, press, errors, lastText };
}

test('strangers are refused', async () => {
  const h = await harness();
  await h.text('/start', { id: 999, is_bot: false, first_name: 'x' });
  assert.match(h.lastText(), /privat/);
});

test('every menu opens without errors', async () => {
  const h = await harness();
  await h.text('/start');
  assert.match(h.lastText(), /TestHero/);
  const routes = ['nav:home', 'nav:refresh', 'nav:log', 'auto:run', 'upg:plan', 'nav:hero', 'nav:inv:0', 'nav:loot', 'afk:prev', 'nav:quest', 'nav:pass', 'pass:calc', 'nav:travel', 'nav:travel:1', 'nav:pet', 'pet:v:leafhopper:common', 'nav:shop', 'shop:c:chest_epic', 'shop:p:common', 'nav:codex', 'nav:ranks', 'nav:set', 'hero:build', 'salv:menu', 'nav:mk:all:all:0', 'nav:mk:rare:weapon:0', 'mk:v:L1', 'mk:mine', 'mk:hist', 'it:v:bronze_stiletto@2', 'it:v:chest_common'];
  for (const r of routes) {
    await h.press(r);
    assert.deepEqual(h.errors().map((e) => e.payload.text), [], r);
  }
});

test('actions: attribute, equip best, loot, quests, settings toggle', async () => {
  const h = await harness();
  await h.press('hero:attr:str');
  assert.equal(h.srv.state.character.attrs.str, 2);
  await h.press('hero:best');
  await h.press('loot:claim');
  await h.press('quest:claim');
  assert.ok(h.srv.daily.missions[0].claimed);
  const before = h.store.settings.autoForge;
  await h.press('set:t:autoForge');
  assert.equal(h.store.settings.autoForge, !before);
  await h.press('hero:setbuild:tank');
  assert.equal(h.store.settings.build, 'tank');
  assert.deepEqual(h.errors(), []);
});

test('spending needs a confirmation tap', async () => {
  const h = await harness();
  const lm0 = h.srv.state.balances.LM;
  await h.press('shop:buy:chest_common');
  assert.equal(h.srv.state.balances.LM, lm0, 'nothing bought before confirming');
  const kb = [...h.sent].reverse().find((s) => s.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('cf:'));
  await h.press(kb.payload.reply_markup.inline_keyboard[0][0].callback_data);
  assert.equal(h.srv.state.balances.LM, lm0 - 2500);
  // a confirmation token works only once
  await h.press(kb.payload.reply_markup.inline_keyboard[0][0].callback_data);
  assert.match(h.lastText(), /kedaluwarsa/);
});

test('typed input: forge reserve and market sell price', async () => {
  const h = await harness();
  await h.press('set:fres');
  await h.text('12k');
  assert.equal(h.store.settings.forgeReserveLm, 12000);
  await h.press('it:sell:bronze_stiletto@2');
  await h.text('abc');
  assert.match(h.lastText(), /tidak valid/);
});

test('private key message is deleted after import', async () => {
  const h = await harness();
  await h.press('w:import');
  await h.text('33'.repeat(32));
  assert.ok(h.sent.some((s) => s.method === 'deleteMessage'));
  assert.equal(h.store.walletAddress(), new ethers.Wallet('0x' + '33'.repeat(32)).address);
});

test('fresh account: pick class, type name, create hero', async () => {
  const h = await harness();
  h.srv.state.character = { userId: '0x1' };
  h.game.last = null;
  await h.text('/start');
  assert.match(h.lastText(), /pilih class/);
  await h.press('new:class:wand');
  assert.match(h.lastText(), /nama hero/);
  await h.text('bad name!!');
  assert.match(h.lastText(), /tidak valid/);
  await h.text('RyMage');
  assert.match(h.lastText(), /RyMage/);
  await h.press('new:look:rand');
  await h.press('new:go');
  assert.equal(h.srv.state.character.classId, 'wand');
  assert.equal(h.srv.state.character.appearance.nick, 'RyMage');
  assert.deepEqual(h.errors(), []);
});

test('market upgrade: plan, confirm, buy and wear', async () => {
  const h = await harness();
  await h.press('upg:plan');
  assert.match(h.lastText(), /Hide Brigandine/);
  await h.press('upg:buy');
  const kb = [...h.sent].reverse().find((s) => s.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('cf:'));
  await h.press(kb.payload.reply_markup.inline_keyboard[0][0].callback_data);
  assert.equal(h.srv.state.equipped.armor, 'hide_brigandine');
  assert.deepEqual(h.errors(), []);
});

test('no session but a key: the bot signs in by itself', async () => {
  const h = await harness();
  h.store.clearSession();
  h.game.api.setCookie('');
  await h.text('/start');
  assert.match(h.lastText(), /TestHero/);
});

test('share your run: link X, wrong account refused, right post submitted', async () => {
  const h = await harness();
  await h.press('share:menu');
  assert.match(h.lastText(), /Hubungkan akun X/);
  await h.press('share:link');
  const linkMsg = [...h.sent].reverse().find((x) => x.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.url);
  assert.match(linkMsg.payload.reply_markup.inline_keyboard[0][0].url, /oauth2/);
  h.srv.daily.community = { status: 'NOT_SUBMITTED', xUsername: 'RyHood' };
  h.game.forget('daily');
  await h.press('share:menu');
  const menu = [...h.sent].reverse().find((x) => x.payload.text?.includes('X terhubung'));
  assert.ok(menu.payload.reply_markup.inline_keyboard.some((r) => r[0].url?.startsWith('https://x.com/intent/tweet?text=')));
  await h.press('share:submit');
  await h.text('https://x.com/someoneelse/status/111');
  assert.match(h.lastText(), /akun X yang terhubung @RyHood/);
  await h.press('share:submit');
  await h.text('https://twitter.com/ryhood/status/222?s=20');
  assert.equal(h.srv.daily.community.status, 'PENDING_REVIEW');
  assert.equal(h.srv.daily.community.tweetUrl, 'https://x.com/ryhood/status/222');
});
