'use strict';
// 博主模式单测：纯本地。用虚构数据覆盖三样——
// 1) bloggers.js 的纯函数：粉丝数解析（"1,234"/"12.3K"/"1.2M"/"3.5万"）、
//    候选评估（商家判定：商家号标记 / 简介+文案信号）、选博主规则
//    （门槛、粉丝未知不入选、排序、同粉丝稳定、topN 上限）；
// 2) harvestProfileInPage 用手写假 document 跑两条路（内嵌 JSON、
//    粉丝链接文本兜底）；
// 3) 命令行新参数（--min-followers / --bloggers / --posts-per-blogger /
//    --no-blogger-mode）的默认值、钳制和 argsFromOptions 映射。
// 不碰浏览器、不碰 IG、不读任何真实文件。
const assert = require('assert');
const bloggers = require('../src/bloggers');
const { parseArgs, argsFromOptions } = require('../collector');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

// ---------- parseFollowerCount ----------

ok('parseFollowerCount: 千分逗号与纯数字', () => {
  assert.strictEqual(bloggers.parseFollowerCount('1,234'), 1234);
  assert.strictEqual(bloggers.parseFollowerCount('1,234,567'), 1234567);
  assert.strictEqual(bloggers.parseFollowerCount('987'), 987);
  assert.strictEqual(bloggers.parseFollowerCount('0'), 0);
  assert.strictEqual(bloggers.parseFollowerCount(1234), 1234);
});

ok('parseFollowerCount: K/M/B 后缀（大小写都认）', () => {
  assert.strictEqual(bloggers.parseFollowerCount('12.3K'), 12300);
  assert.strictEqual(bloggers.parseFollowerCount('12.3k'), 12300);
  assert.strictEqual(bloggers.parseFollowerCount('1.2M'), 1200000);
  assert.strictEqual(bloggers.parseFollowerCount('1.2m'), 1200000);
  assert.strictEqual(bloggers.parseFollowerCount('1.5B'), 1500000000);
  assert.strictEqual(bloggers.parseFollowerCount('12.3K followers'), 12300);
});

ok('parseFollowerCount: 中文万/亿', () => {
  assert.strictEqual(bloggers.parseFollowerCount('3.5万'), 35000);
  assert.strictEqual(bloggers.parseFollowerCount('37.2万'), 372000);
  assert.strictEqual(bloggers.parseFollowerCount('37.2万粉丝'), 372000);
  assert.strictEqual(bloggers.parseFollowerCount('1.2亿'), 120000000);
});

ok('parseFollowerCount: 认不出给 null，绝不编造', () => {
  assert.strictEqual(bloggers.parseFollowerCount('abc'), null);
  assert.strictEqual(bloggers.parseFollowerCount(''), null);
  assert.strictEqual(bloggers.parseFollowerCount('   '), null);
  assert.strictEqual(bloggers.parseFollowerCount(null), null);
  assert.strictEqual(bloggers.parseFollowerCount(undefined), null);
  assert.strictEqual(bloggers.parseFollowerCount(NaN), null);
});

// ---------- 显示格式 ----------

ok('formatFollowers: 万位格式与未知', () => {
  assert.strictEqual(bloggers.formatFollowers(123456), '12.3万');
  assert.strictEqual(bloggers.formatFollowers(10000), '1万');
  assert.strictEqual(bloggers.formatFollowers(1234567), '123.5万');
  assert.strictEqual(bloggers.formatFollowers(9999), '9,999');
  assert.strictEqual(bloggers.formatFollowers(0), '0');
  assert.strictEqual(bloggers.formatFollowers(null), '未知');
});

ok('formatFollowersFull: 精确千分逗号', () => {
  assert.strictEqual(bloggers.formatFollowersFull(123456), '123,456');
  assert.strictEqual(bloggers.formatFollowersFull(3210), '3,210');
  assert.strictEqual(bloggers.formatFollowersFull(null), '未知');
});

// ---------- evaluateProfileCandidate ----------

ok('evaluate: 商家号标记直接算商家（无文案信号也算）', () => {
  const c = bloggers.evaluateProfileCandidate({ username: 'shop_a', followers: 50000, isBusiness: true, bio: 'hello' });
  assert.strictEqual(c.merchant, true);
  assert.strictEqual(c.isBusiness, true);
  assert.deepStrictEqual(c.signals, []);
});

ok('evaluate: 简介命中售卖信号算商家', () => {
  const c = bloggers.evaluateProfileCandidate({ username: 'bags_b', followers: 20000, isBusiness: false, bio: 'DM to order 📦 WhatsApp us' });
  assert.strictEqual(c.merchant, true);
  assert.ok(c.signals.some((s) => s.includes('WhatsApp')));
});

ok('evaluate: 文案（找候选时记下的）也能补商家信号', () => {
  const c = bloggers.evaluateProfileCandidate({ username: 'bags_c', followers: 20000, isBusiness: null, bio: '', captions: ['New bags in store, price $50'] });
  assert.strictEqual(c.merchant, true);
  assert.ok(c.signals.length > 0);
});

ok('evaluate: 普通博主不算商家', () => {
  const c = bloggers.evaluateProfileCandidate({ username: 'photo_d', followers: 900000, isBusiness: false, bio: 'photographer | coffee lover' });
  assert.strictEqual(c.merchant, false);
  assert.deepStrictEqual(c.signals, []);
});

ok('evaluate: 粉丝数字符串会解析，垃圾值给 null', () => {
  assert.strictEqual(bloggers.evaluateProfileCandidate({ username: 'x', followers: '37.2万' }).followers, 372000);
  assert.strictEqual(bloggers.evaluateProfileCandidate({ username: 'x', followers: 123456 }).followers, 123456);
  assert.strictEqual(bloggers.evaluateProfileCandidate({ username: 'x', followers: 'garbage' }).followers, null);
  assert.strictEqual(bloggers.evaluateProfileCandidate({ username: 'x', followers: null }).followers, null);
});

// ---------- selectBloggers ----------

function cand(username, followers, merchant) {
  return { username: username, followers: followers, merchant: merchant, signals: [], isBusiness: false, category: null, bio: '' };
}

ok('select: 门槛是 >=（正好达标入选，差一个不行）', () => {
  const sel = bloggers.selectBloggers([cand('a', 10000, true), cand('b', 9999, true)], { minFollowers: 10000, topN: 5 });
  assert.deepStrictEqual(sel.map((c) => c.username), ['a']);
});

ok('select: 粉丝数未知一律不入选（哪怕是商家）', () => {
  const sel = bloggers.selectBloggers([cand('a', null, true), cand('b', 50000, true)], { minFollowers: 10000, topN: 5 });
  assert.deepStrictEqual(sel.map((c) => c.username), ['b']);
});

ok('select: 不是商家，粉丝再多也不入选', () => {
  const sel = bloggers.selectBloggers([cand('a', 5000000, false)], { minFollowers: 10000, topN: 5 });
  assert.deepStrictEqual(sel, []);
});

ok('select: 按粉丝从多到少排，topN 封顶', () => {
  const sel = bloggers.selectBloggers(
    [cand('a', 20000, true), cand('b', 90000, true), cand('c', 50000, true), cand('d', 30000, true)],
    { minFollowers: 10000, topN: 2 });
  assert.deepStrictEqual(sel.map((c) => c.username), ['b', 'c']);
});

ok('select: 同粉丝数保持原来的先后顺序（稳定）', () => {
  const sel = bloggers.selectBloggers(
    [cand('first', 50000, true), cand('second', 50000, true), cand('third', 50000, true)],
    { minFollowers: 10000, topN: 3 });
  assert.deepStrictEqual(sel.map((c) => c.username), ['first', 'second', 'third']);
});

ok('select: 空输入/坏输入安全', () => {
  assert.deepStrictEqual(bloggers.selectBloggers([], { minFollowers: 10000, topN: 5 }), []);
  assert.deepStrictEqual(bloggers.selectBloggers(null, {}), []);
  assert.deepStrictEqual(bloggers.selectBloggers([null, cand('a', 10000, true)], { minFollowers: 10000, topN: 5 }).length, 1);
});

// ---------- harvestProfileInPage（假 document） ----------

function withFakeDocument(fakeDoc, fn) {
  const had = Object.prototype.hasOwnProperty.call(global, 'document');
  const prev = global.document;
  global.document = fakeDoc;
  try { return fn(); }
  finally {
    if (had) global.document = prev;
    else delete global.document;
  }
}

ok('harvest: 内嵌 JSON 路（粉丝/商家/类目/简介）', () => {
  const payload = JSON.stringify({
    require: [[{ user: {
      edge_followed_by: { count: 123456 },
      is_business_account: true,
      category_name: 'Shopping & retail',
      biography: 'DM to order, worldwide shipping',
    } }]],
  });
  const fakeDoc = {
    querySelectorAll: (sel) => (sel === 'script[type="application/json"]' ? [{ textContent: payload }] : []),
    querySelector: () => null,
  };
  const r = withFakeDocument(fakeDoc, () => bloggers.harvestProfileInPage('shop_a'));
  assert.strictEqual(r.followers, 123456);
  assert.strictEqual(r.isBusiness, true);
  assert.strictEqual(r.category, 'Shopping & retail');
  assert.strictEqual(r.bio, 'DM to order, worldwide shipping');
  assert.strictEqual(r.username, 'shop_a');
});

ok('harvest: 粉丝链接文本兜底（缩写文本优先）', () => {
  const link = {
    getAttribute: (name) => (name === 'href' ? '/someone/followers/' : null),
    textContent: '12.3K followers',
    querySelectorAll: () => [{ getAttribute: (name) => (name === 'title' ? '12,345' : null) }],
  };
  const fakeDoc = {
    querySelectorAll: (sel) => (sel === 'a[href]' ? [link] : []),
    querySelector: () => null,
  };
  const r = withFakeDocument(fakeDoc, () => bloggers.harvestProfileInPage('someone'));
  assert.strictEqual(r.followers, 12300);
  assert.strictEqual(r.isBusiness, null);
});

ok('harvest: 链接 title 精确数 + meta 简介兜底', () => {
  const link = {
    getAttribute: (name) => {
      if (name === 'href') return '/shop_b/followers/';
      if (name === 'title') return '98,765';
      return null;
    },
    textContent: '',
    querySelectorAll: () => [],
  };
  const meta = { getAttribute: (name) => (name === 'content' ? '98,765 Followers, 12 Following, 340 Posts - Bags shop, wholesale' : null) };
  const fakeDoc = {
    querySelectorAll: (sel) => (sel === 'a[href]' ? [link] : []),
    querySelector: (sel) => (sel === 'meta[name="description"]' ? meta : null),
  };
  const r = withFakeDocument(fakeDoc, () => bloggers.harvestProfileInPage('shop_b'));
  assert.strictEqual(r.followers, 98765);
  assert.strictEqual(r.bio, 'Bags shop, wholesale');
});

ok('harvest: 什么都读不到就全 null，不编造', () => {
  const fakeDoc = { querySelectorAll: () => [], querySelector: () => null };
  const r = withFakeDocument(fakeDoc, () => bloggers.harvestProfileInPage('ghost'));
  assert.strictEqual(r.followers, null);
  assert.strictEqual(r.isBusiness, null);
  assert.strictEqual(r.bio, null);
});

// ---------- 命令行参数 ----------

ok('args: 博主模式默认开，三个参数有默认值', () => {
  const a = parseArgs(['--keyword', 'downjacket']);
  assert.strictEqual(a.bloggerMode, true);
  assert.strictEqual(a.minFollowers, 10000);
  assert.strictEqual(a.bloggers, 5);
  assert.strictEqual(a.postsPerBlogger, 10);
});

ok('args: --no-blogger-mode 关掉博主模式', () => {
  assert.strictEqual(parseArgs(['--keyword', 'a', '--no-blogger-mode']).bloggerMode, false);
  assert.strictEqual(parseArgs(['--keyword', 'a', '--no-blogger-mode', '--blogger-mode']).bloggerMode, true);
});

ok('args: --min-followers / --bloggers / --posts-per-blogger（空格与 = 两种写法）', () => {
  const a = parseArgs(['--keyword', 'a', '--min-followers', '5000', '--bloggers', '3', '--posts-per-blogger', '8']);
  assert.strictEqual(a.minFollowers, 5000);
  assert.strictEqual(a.bloggers, 3);
  assert.strictEqual(a.postsPerBlogger, 8);
  const b = parseArgs(['--keyword', 'a', '--min-followers=20000', '--bloggers=7', '--posts-per-blogger=15']);
  assert.strictEqual(b.minFollowers, 20000);
  assert.strictEqual(b.bloggers, 7);
  assert.strictEqual(b.postsPerBlogger, 15);
});

ok('args: 非法值回落默认、超限钳制', () => {
  const a = parseArgs(['--keyword', 'a', '--min-followers', 'abc', '--bloggers', '0', '--posts-per-blogger', '0']);
  assert.strictEqual(a.minFollowers, 10000);
  assert.strictEqual(a.bloggers, 5);
  assert.strictEqual(a.postsPerBlogger, 10);
  const b = parseArgs(['--keyword', 'a', '--bloggers', '99', '--posts-per-blogger', '999']);
  assert.strictEqual(b.bloggers, 20);
  assert.strictEqual(b.postsPerBlogger, 50);
});

ok('argsFromOptions: GUI 的 minFollowers/bloggers 正确映射', () => {
  const a = argsFromOptions({ keywords: ['x'], minFollowers: 3000, bloggers: 2, postsPerBlogger: 7 });
  assert.strictEqual(a.minFollowers, 3000);
  assert.strictEqual(a.bloggers, 2);
  assert.strictEqual(a.postsPerBlogger, 7);
  assert.strictEqual(a.bloggerMode, true);
  const b = argsFromOptions({ keywords: ['x'], bloggerMode: false });
  assert.strictEqual(b.bloggerMode, false);
  const c = argsFromOptions({ keywords: ['x'] });
  assert.strictEqual(c.minFollowers, 10000);
  assert.strictEqual(c.bloggers, 5);
});

console.log('博主模式单测全部通过：' + passed + ' 项');
