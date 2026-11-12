'use strict';
// 三道采集筛选的纯函数单测：新鲜度（src/filters.js decidePostAge）、
// 商家帖文案信号（src/filters.js merchantSignalsOf）、评论意向预筛
// （src/intent.js，与 app/src/intentLeads.js 同一套词表）。不联网、不开浏览器。
const assert = require('assert');
const filters = require('../src/filters');
const intent = require('../src/intent');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

const NOW = new Date('2026-11-12T12:00:00.000Z');

// ---------- 新鲜度判定 ----------
ok('age: 2023-05 post with 365 limit -> skip', () => {
  const d = filters.decidePostAge({ timestamp: '2023-05-01T00:00:00.000Z', now: NOW, maxAgeDays: 365 });
  assert.strictEqual(d.action, 'skip');
  assert.ok(d.ageDays > 365);
});
ok('age: 30-day-old post -> keep', () => {
  const d = filters.decidePostAge({ timestamp: '2026-10-13T12:00:00.000Z', now: NOW, maxAgeDays: 365 });
  assert.strictEqual(d.action, 'keep');
  assert.ok(Math.abs(d.ageDays - 30) < 0.01);
});
ok('age: unknown timestamp -> keep, ageDays null', () => {
  assert.deepStrictEqual(filters.decidePostAge({ timestamp: null, now: NOW, maxAgeDays: 365 }), { action: 'keep', ageDays: null });
  assert.deepStrictEqual(filters.decidePostAge({ timestamp: '', now: NOW, maxAgeDays: 365 }), { action: 'keep', ageDays: null });
  assert.deepStrictEqual(filters.decidePostAge({ timestamp: 'not-a-date', now: NOW, maxAgeDays: 365 }), { action: 'keep', ageDays: null });
});
ok('age: maxAgeDays 0 means unlimited', () => {
  const d = filters.decidePostAge({ timestamp: '2023-05-01T00:00:00.000Z', now: NOW, maxAgeDays: 0 });
  assert.strictEqual(d.action, 'keep');
});
ok('age: exactly at limit keeps, one day over skips', () => {
  assert.strictEqual(filters.decidePostAge({ timestamp: '2025-11-12T12:00:00.000Z', now: NOW, maxAgeDays: 365 }).action, 'keep');
  assert.strictEqual(filters.decidePostAge({ timestamp: '2025-11-11T12:00:00.000Z', now: NOW, maxAgeDays: 365 }).action, 'skip');
});
ok('age: future timestamp (clock skew) keeps', () => {
  assert.strictEqual(filters.decidePostAge({ timestamp: '2026-12-01T00:00:00.000Z', now: NOW, maxAgeDays: 365 }).action, 'keep');
});
ok('age: numeric epoch timestamp also works', () => {
  const d = filters.decidePostAge({ timestamp: Date.UTC(2023, 4, 1) / 1000, now: NOW, maxAgeDays: 365 });
  // 数字按 extract.toIso 同一口径：这里传的是秒级数值，decidePostAge 用 Date 解析
  // Date(1682899200) 是毫秒口径会落在 1970 年——仍应 skip（比上限老得多），
  // 本用例只钉住“数字输入不炸、结论仍是 skip”。
  assert.strictEqual(d.action, 'skip');
});

// ---------- 评论意向分类（词表与 app/src/intentLeads.js 对齐） ----------
ok('intent: 多少钱 -> 问价格', () => {
  assert.deepStrictEqual(intent.commentIntent('这个多少钱？'), ['问价格']);
});
ok('intent: what size -> 问尺码', () => {
  assert.deepStrictEqual(intent.commentIntent('what size do you have?'), ['问尺码']);
});
ok('intent: how to buy -> 问购买', () => {
  assert.deepStrictEqual(intent.commentIntent('how to buy this?'), ['问购买']);
});
ok('intent: do you ship to Canada -> 问运费', () => {
  assert.deepStrictEqual(intent.commentIntent('do you ship to Canada?'), ['问运费']);
});
ok('intent: Nice! -> none', () => {
  assert.deepStrictEqual(intent.commentIntent('Nice!'), []);
  assert.deepStrictEqual(intent.commentIntent(''), []);
  assert.deepStrictEqual(intent.commentIntent(null), []);
});
ok('intent: How much? How to buy? -> 问购买 + 问价格 (category order)', () => {
  assert.deepStrictEqual(intent.commentIntent('How much? How to buy?'), ['问购买', '问价格']);
});
ok('intent: 中文多命中 多少钱，怎么购买', () => {
  assert.deepStrictEqual(intent.commentIntent('请问多少钱，怎么购买'), ['问购买', '问价格']);
});
ok('intent: 包邮吗 + 尺码 -> 问运费 + 问尺码', () => {
  assert.deepStrictEqual(intent.commentIntent('包邮吗？有大尺码吗'), ['问运费', '问尺码']);
});

// ---------- 评论筛选接线（filterCommentsByIntent） ----------
ok('intent filter: default keeps only intent comments and tags intentTypes', () => {
  const comments = [
    { text: '多少钱', ownerUsername: 'a' },
    { text: 'Nice!', ownerUsername: 'b' },
    { text: 'How to buy and how much?', ownerUsername: 'c' },
  ];
  const r = intent.filterCommentsByIntent(comments, false);
  assert.strictEqual(r.seen, 3);
  assert.strictEqual(r.intentCount, 2);
  assert.strictEqual(r.kept.length, 2);
  assert.deepStrictEqual(r.kept[0].intentTypes, ['问价格']);
  assert.deepStrictEqual(r.kept[1].intentTypes, ['问购买', '问价格']);
});
ok('intent filter: --keep-all keeps everything, still tags', () => {
  const comments = [
    { text: 'Nice!', ownerUsername: 'b' },
    { text: 'do you ship to Japan?', ownerUsername: 'd' },
  ];
  const r = intent.filterCommentsByIntent(comments, true);
  assert.strictEqual(r.seen, 2);
  assert.strictEqual(r.intentCount, 1);
  assert.strictEqual(r.kept.length, 2);
  assert.deepStrictEqual(r.kept[0].intentTypes, []);
  assert.deepStrictEqual(r.kept[1].intentTypes, ['问运费']);
});

// ---------- 商家帖文案信号 ----------
ok('merchant: DM to order', () => {
  const s = filters.merchantSignalsOf('New stock arrived, DM to order 📩');
  assert.ok(s.includes('文案含 DM to buy/order'));
  assert.ok(s.includes('文案含 order'));
  assert.strictEqual(filters.isMerchantCaption('DM to order 📩'), true);
});
ok('merchant: 私信下单', () => {
  const s = filters.merchantSignalsOf('看中直接私信下单');
  assert.ok(s.includes('文案含 私信'));
  assert.ok(s.includes('文案含 下单'));
});
ok('merchant: $129 shop now, link in bio', () => {
  const s = filters.merchantSignalsOf('$129 — shop now, link in bio');
  assert.ok(s.includes('文案含 $'));
  assert.ok(s.includes('文案含 shop'));
  assert.ok(s.includes('文案含 link in bio'));
});
ok('merchant: WhatsApp me to buy', () => {
  assert.ok(filters.merchantSignalsOf('WhatsApp me to buy').includes('文案含 WhatsApp'));
});
ok('merchant: 新款到货，店铺有售', () => {
  assert.ok(filters.merchantSignalsOf('新款到货，店铺有售').includes('文案含 店铺'));
});
ok('merchant: 批发/订购/出售/wa.me supplements', () => {
  assert.ok(filters.merchantSignalsOf('厂家批发，一件代发').includes('文案含 批发'));
  assert.ok(filters.merchantSignalsOf('wholesale only').includes('文案含 wholesale'));
  assert.ok(filters.merchantSignalsOf('接受订购').includes('文案含 订购'));
  assert.ok(filters.merchantSignalsOf('闲置出售').includes('文案含 出售'));
  assert.ok(filters.merchantSignalsOf('联系 wa.me/12345').includes('文案含 wa.me'));
});
ok('passerby: lifestyle captions are not merchant', () => {
  assert.deepStrictEqual(filters.merchantSignalsOf('love my new down jacket ❄️ #winteroutfit'), []);
  assert.deepStrictEqual(filters.merchantSignalsOf('POV: first snow'), []);
  assert.strictEqual(filters.isMerchantCaption('love my new down jacket ❄️ #winteroutfit'), false);
});
ok('passerby: hashtags/emojis only caption is not merchant', () => {
  assert.deepStrictEqual(filters.merchantSignalsOf('#winter ❄️❄️'), []);
  assert.deepStrictEqual(filters.merchantSignalsOf(''), []);
  assert.deepStrictEqual(filters.merchantSignalsOf(null), []);
});
ok('passerby: 咖啡店 does not false-positive on 店', () => {
  // 信号表里只有“商店/店铺”两个完整词，没有单个“店”，所以生活词不误伤
  assert.deepStrictEqual(filters.merchantSignalsOf('在这家咖啡店拍照打卡，窗边光线绝了'), []);
  assert.deepStrictEqual(filters.merchantSignalsOf('周末去书店逛了一下午'), []);
});

// ---------- 商家筛选开关接线（collector.parseArgs） ----------
// 用户 2026-11-12 拍板：商家筛选默认关，只要有评论且有意向评论就采；
// --merchant-filter 才打开；旧的 --no-merchant-filter 保留为无操作。
const { parseArgs } = require('../collector');
ok('wiring: merchant filter defaults OFF', () => {
  const a = parseArgs(['--keyword', 'downjacket']);
  assert.strictEqual(a.merchantFilter, false);
});
ok('wiring: --merchant-filter turns it ON', () => {
  const a = parseArgs(['--keyword', 'downjacket', '--merchant-filter']);
  assert.strictEqual(a.merchantFilter, true);
});
ok('wiring: --no-merchant-filter is a harmless no-op (stays OFF)', () => {
  const a = parseArgs(['--keyword', 'downjacket', '--no-merchant-filter']);
  assert.strictEqual(a.merchantFilter, false);
});

console.log('筛选单测全部通过：' + passed + ' 项');
