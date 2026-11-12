'use strict';
// 纯本地单测：不联网、不登录、不开浏览器。
// 覆盖 guard（黑名单/停止页）与 extract（链接/计数/夹具帖子解析）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const guard = require('../src/guard');
const extract = require('../src/extract');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

// ---- 黑名单：3 个受保护账号，大小写/带@都要命中 ----
ok('blocklist hit nataliem.jordan', () => {
  assert.strictEqual(guard.isBlockedUsername('nataliem.jordan'), true);
});
ok('blocklist hit mm8989221 (case-insensitive)', () => {
  assert.strictEqual(guard.isBlockedUsername('MM8989221'), true);
});
ok('blocklist hit lvlong2026 (with @)', () => {
  assert.strictEqual(guard.isBlockedUsername('@lvlong2026'), true);
});
ok('blocklist miss sample small account', () => {
  assert.strictEqual(guard.isBlockedUsername('my_small_shop_01'), false);
  assert.strictEqual(guard.isBlockedUsername(''), false);
  assert.strictEqual(guard.isBlockedUsername(null), false);
});

// ---- 停止页检测 ----
ok('stop: checkpoint by URL', () => {
  const r = guard.detectStopPage({ url: 'https://www.instagram.com/challenge/9988123/', text: '' });
  assert.strictEqual(r && r.reason, 'checkpoint');
});
ok('stop: checkpoint by text', () => {
  const r = guard.detectStopPage({ url: 'https://www.instagram.com/', text: "Help us confirm it's you. We detected a suspicious login attempt." });
  assert.strictEqual(r && r.reason, 'checkpoint');
});
ok('stop: login wall by URL', () => {
  const r = guard.detectStopPage({ url: 'https://www.instagram.com/accounts/login/?next=%2F', text: 'Welcome' });
  assert.strictEqual(r && r.reason, 'login_wall');
});
ok('stop: rate limit by text', () => {
  const r = guard.detectStopPage({ url: 'https://www.instagram.com/', text: 'Please wait a few minutes before you try again later.' });
  assert.strictEqual(r && r.reason, 'rate_limit');
});
ok('stop: normal page = null', () => {
  const r = guard.detectStopPage({ url: 'https://www.instagram.com/explore/tags/downjacket/', text: 'downjacket winter outfits puffer jackets new posts every day' });
  assert.strictEqual(r, null);
});

// ---- 链接与计数解析 ----
ok('extract post links dedupe', () => {
  const links = extract.extractPostLinksFromHrefs(['/p/ABC123x/', '/reel/XYZ_9-/', '/explore/tags/downjacket/', '/p/ABC123x/', '/someuser/']);
  assert.strictEqual(links.length, 2);
  assert.strictEqual(links[0].shortCode, 'ABC123x');
  assert.strictEqual(links[1].url, 'https://www.instagram.com/reel/XYZ_9-/');
});
ok('parseCount', () => {
  assert.strictEqual(extract.parseCount('1,234'), 1234);
  assert.strictEqual(extract.parseCount('1.5k'), 1500);
  assert.strictEqual(extract.parseCount(42), 42);
  assert.strictEqual(extract.parseCount('no numbers'), null);
  assert.strictEqual(extract.parseCount(null), null);
});
ok('parseOgCounts', () => {
  const c = extract.parseOgCounts('321 likes, 45 comments - sample on Instagram');
  assert.strictEqual(c.likesCount, 321);
  assert.strictEqual(c.commentsCount, 45);
});

// ---- 夹具帖子解析（假页面文本，内嵌 JSON 里有 1 帖 + 2 评论） ----
ok('fixture post parse', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixture-post.txt'), 'utf8');
  const r = extract.extractPostFromText(text, 'https://www.instagram.com/p/FIXTURE001/');
  assert.ok(r, 'fixture should parse');
  assert.strictEqual(r.post.shortCode, 'FIXTURE001');
  assert.strictEqual(r.post.ownerUsername, 'sample_down_shop');
  assert.ok(r.post.caption.includes('down jacket'));
  assert.deepStrictEqual(r.post.hashtags, ['downjacket', 'winter']);
  assert.strictEqual(r.post.likesCount, 321);
  assert.strictEqual(r.post.commentsCount, 2);
  assert.strictEqual(r.post.url, 'https://www.instagram.com/p/FIXTURE001/');
  assert.strictEqual(r.comments.length, 2);
  assert.strictEqual(r.comments[0].ownerUsername, 'buyer_anna');
  assert.ok(r.comments[0].text.includes('How much'));
  assert.strictEqual(r.comments[0].postUrl, 'https://www.instagram.com/p/FIXTURE001/');
  assert.strictEqual(r.comments[1].ownerUsername, 'maple_mike');
});

console.log('单测全部通过：' + passed + ' 项');
