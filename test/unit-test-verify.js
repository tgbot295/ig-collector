'use strict';
// 登录核验分类器单测（纯函数，不联网、不开浏览器）。
// 背景：曾只凭“没提取到用户名”就把活会话判 session_expired（页面其实已登录）。
// 现在的准绳：上下文有 sessionid + 不在登录 URL + 无可见密码框 → 已登录；
// session_expired 只允许在第二轮仍有严格登录墙（登录 URL 或可见密码框）时判。
const assert = require('assert');
const guard = require('../src/guard');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

const HOME = 'https://www.instagram.com/';
const base = {
  url: HOME, title: 'Instagram',
  urlIsLogin: false, hasVisiblePasswordInput: false, hasLoginForm: false,
  hasProfileNavSignal: false, hasCheckpointSignal: false,
  hasSessionidCookie: false, hasUsername: false,
};
const sig = (over) => Object.assign({}, base, over);
const verdict = (s, p) => guard.classifyLoginSignals(s, p).verdict;

ok('verify: login wall on first pass → retry (not expired)', () => {
  const s = sig({ url: 'https://www.instagram.com/accounts/login/', urlIsLogin: true, hasVisiblePasswordInput: true, hasLoginForm: true });
  assert.strictEqual(verdict(s, 1), 'retry');
});

ok('verify: login wall on BOTH passes → session_expired', () => {
  const s = sig({ url: 'https://www.instagram.com/accounts/login/', urlIsLogin: true, hasVisiblePasswordInput: true, hasLoginForm: true });
  assert.strictEqual(verdict(s, 1), 'retry');
  assert.strictEqual(verdict(s, 2), 'session_expired');
});

ok('verify: checkpoint URL → checkpoint (either pass)', () => {
  assert.strictEqual(verdict(sig({ url: 'https://www.instagram.com/challenge/12345/' }), 1), 'checkpoint');
  assert.strictEqual(verdict(sig({ url: 'https://www.instagram.com/auth_platform/' }), 1), 'checkpoint');
  assert.strictEqual(verdict(sig({ hasCheckpointSignal: true }), 2), 'checkpoint');
});

ok('verify: profile nav signal → logged_in', () => {
  assert.strictEqual(verdict(sig({ hasProfileNavSignal: true }), 1), 'logged_in');
});

ok('verify: username signal → logged_in', () => {
  assert.strictEqual(verdict(sig({ hasUsername: true }), 1), 'logged_in');
});

ok('verify: onetap URL + sessionid cookie + no password field → logged_in', () => {
  // /accounts/onetap/ 是“保存登录信息”插屏页，不是登录墙，绝不能误读
  const s = sig({ url: 'https://www.instagram.com/accounts/onetap/', hasSessionidCookie: true });
  assert.strictEqual(verdict(s, 1), 'logged_in');
});

ok('verify: logged-in feed without extractable username → logged_in (username stays null upstream)', () => {
  const s = sig({ hasSessionidCookie: true }); // 首页、无导航信号、没读到用户名
  assert.strictEqual(verdict(s, 1), 'logged_in');
});

ok('verify: ambiguous first pass → retry, NOT expired', () => {
  assert.strictEqual(verdict(sig({}), 1), 'retry');
});

ok('verify: ambiguous second pass → not_confirmed, NOT expired', () => {
  assert.strictEqual(verdict(sig({}), 2), 'not_confirmed');
});

ok('verify: sessionid present but ON login URL with visible password, pass 2 → session_expired', () => {
  const s = sig({
    url: 'https://www.instagram.com/accounts/login/', urlIsLogin: true,
    hasVisiblePasswordInput: true, hasSessionidCookie: true,
  });
  assert.strictEqual(verdict(s, 1), 'retry'); // 准绳被登录 URL 否决，第一轮仍只给 retry
  assert.strictEqual(verdict(s, 2), 'session_expired');
});

ok('verify: sessionid present but visible password on home URL, pass 2 → session_expired (strict wall)', () => {
  const s = sig({ hasVisiblePasswordInput: true, hasLoginForm: true, hasSessionidCookie: true });
  assert.strictEqual(verdict(s, 2), 'session_expired');
});

ok('verify: hidden login form only (no visible password, no login URL), pass 2 → not_confirmed', () => {
  const s = sig({ hasLoginForm: true });
  assert.strictEqual(verdict(s, 1), 'retry');
  assert.strictEqual(verdict(s, 2), 'not_confirmed');
});

ok('verify: checkpoint beats logged-in-looking signals', () => {
  const s = sig({ url: 'https://www.instagram.com/challenge/9/', hasSessionidCookie: true, hasProfileNavSignal: true });
  assert.strictEqual(verdict(s, 1), 'checkpoint');
});

console.log('登录核验分类器单测全部通过：' + passed + ' 项');
