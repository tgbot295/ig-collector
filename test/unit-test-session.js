'use strict';
// 会话文件单测：只用虚构假数据，不联网、不登录、不开浏览器。
// 重点：cookie 两种形状的转换、无关域名丢弃、缺省字段补齐、缺 sessionid 只点名报错、
// storageState 0600 落盘往返、导入会话的黑名单判定、任何输出都不含假 sessionid 的值。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sessionStore = require('../src/session');
const guard = require('../src/guard');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

const FAKE_SESSION_ID = 'FAKESESSIONID123';
const FAKE_CSRF = 'FAKECSRFTOKEN456';

const FAKE_COOKIES_ARRAY = [
  { name: 'sessionid', value: FAKE_SESSION_ID, domain: '.instagram.com', path: '/', expirationDate: 1893456000, httpOnly: true, secure: true },
  { name: 'csrftoken', value: FAKE_CSRF, domain: '.instagram.com' },
  { name: 'ds_user_id', value: '1234567890', domain: 'www.instagram.com', path: '/' },
  { name: 'NID', value: 'fake-google-cookie', domain: '.google.com', path: '/' },
];

let state = null;
ok('cookies: bare array converts, unrelated domain dropped', () => {
  state = sessionStore.toStorageState(FAKE_COOKIES_ARRAY);
  assert.strictEqual(state.cookies.length, 3);
  assert.ok(state.cookies.every((c) => !String(c.domain).includes('google')));
  assert.ok(sessionStore.hasCookie(state, 'sessionid'));
});

ok('cookies: defaults filled (sessionid httpOnly, csrftoken secure/path)', () => {
  const sid = state.cookies.find((c) => c.name === 'sessionid');
  assert.strictEqual(sid.httpOnly, true);
  assert.strictEqual(sid.secure, true);
  assert.strictEqual(sid.domain, '.instagram.com');
  assert.strictEqual(sid.expires, 1893456000);
  const csrf = state.cookies.find((c) => c.name === 'csrftoken');
  assert.strictEqual(csrf.path, '/');
  assert.strictEqual(csrf.secure, true);
  assert.strictEqual(csrf.expires, -1);
  const ds = state.cookies.find((c) => c.name === 'ds_user_id');
  assert.strictEqual(ds.domain, '.instagram.com');
});

ok('cookies: object shape {cookies:[...]} works, origins filtered to IG', () => {
  const objState = sessionStore.toStorageState({
    cookies: FAKE_COOKIES_ARRAY,
    origins: [
      { origin: 'https://www.instagram.com', localStorage: [] },
      { origin: 'https://example.com', localStorage: [] },
    ],
  });
  assert.strictEqual(objState.cookies.length, 3);
  assert.strictEqual(objState.origins.length, 1);
  assert.ok(objState.origins[0].origin.includes('instagram.com'));
});

ok('cookies: missing sessionid errors by NAME only, no values in message', () => {
  let err = null;
  try {
    sessionStore.toStorageState([{ name: 'csrftoken', value: FAKE_CSRF, domain: '.instagram.com' }]);
  } catch (e) { err = e; }
  assert.ok(err, 'should throw');
  assert.ok(err.message.includes('sessionid'), 'error should name sessionid');
  assert.ok(!err.message.includes(FAKE_CSRF), 'error must not contain any cookie value');
});

ok('session: storageState 0600 write/read round-trip keeps structure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-session-test-'));
  const file = sessionStore.sessionFilePath(dir, 'Sample_Small_A');
  assert.ok(file.endsWith('sample_small_a.storage.json'));
  sessionStore.writeStorageStateFile(file, state);
  const mode = fs.statSync(file).mode & 0o777;
  assert.strictEqual(mode, 0o600, 'file mode should be 0600, got ' + mode.toString(8));
  const back = sessionStore.loadSessionFile(file);
  assert.strictEqual(back.cookies.length, 3);
  assert.ok(sessionStore.hasCookie(back, 'sessionid'));
  assert.deepStrictEqual(
    sessionStore.summarizeState(back).cookieNames,
    ['csrftoken', 'ds_user_id', 'sessionid']
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

ok('session: imported-session username goes through blocklist guard', () => {
  // collector.js 在导入模式下用 detectLoggedInUsername 拿到用户名后调这个守卫，
  // 命中主号在采集前中止（退出码 2）。这里在单元层验证同一条判定路径。
  assert.strictEqual(guard.isBlockedUsername('nataliem.jordan', guard.DEFAULT_BLOCKLIST), true);
  assert.strictEqual(guard.isBlockedUsername('NatalieM.Jordan', guard.DEFAULT_BLOCKLIST), true);
  assert.strictEqual(guard.isBlockedUsername('@mm8989221', guard.DEFAULT_BLOCKLIST), true);
  assert.strictEqual(guard.isBlockedUsername('sample_small_a', guard.DEFAULT_BLOCKLIST), false);
});

ok('hygiene: summaries and errors never contain the fake sessionid value', () => {
  const outputs = [];
  outputs.push(JSON.stringify(sessionStore.summarizeState(state)));
  outputs.push(sessionStore.sessionFilePath('/tmp/x', 'sample_small_a'));
  try { sessionStore.parseSessionText('{"cookies":[{"name":"csrftoken","value":"' + FAKE_CSRF + '"}]}'); } catch (e) { outputs.push(e.message); }
  try { sessionStore.parseSessionText('not json at all'); } catch (e) { outputs.push(e.message); }
  const blob = outputs.join('\n');
  assert.ok(!blob.includes(FAKE_SESSION_ID), 'sessionid value leaked into output');
  assert.ok(!blob.includes(FAKE_CSRF), 'csrftoken value leaked into output');
});

// ---- 卖家式真实导出形状：首行非 JSON 标签行 + cookie-editor 字段 ----
const SELLER_EXPORT_TEXT = [
  '某某卖家账号导出 cookies（这一行是标题，不是 JSON）',
  JSON.stringify([
    { name: 'sessionid', value: FAKE_SESSION_ID, domain: '.instagram.com', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', session: false, expirationDate: 1893456000.75, storeId: '0' },
    { name: 'csrftoken', value: FAKE_CSRF, domain: '.instagram.com', hostOnly: true, path: '/', secure: true, httpOnly: false, sameSite: null, session: false, expirationDate: 1893456000.1, storeId: '0' },
    { name: 'ds_user_id', value: '1234567890', domain: '.instagram.com', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'LAX', session: false, expirationDate: 1893456000.9, storeId: '0' },
    { name: 'mid', value: 'fake-mid-value', domain: '.instagram.com', hostOnly: false, path: '/', secure: true, httpOnly: false, sameSite: 'Strict', session: true, storeId: '0' },
  ]),
].join('\n');

let sellerState = null;
ok('seller export: leading label line tolerated, parse succeeds', () => {
  sellerState = sessionStore.parseSessionText(SELLER_EXPORT_TEXT);
  assert.strictEqual(sellerState.cookies.length, 4);
  assert.ok(sessionStore.hasCookie(sellerState, 'sessionid'));
});

ok('seller export: expirationDate float seconds mapped to expires (floored)', () => {
  const sid = sellerState.cookies.find((c) => c.name === 'sessionid');
  assert.strictEqual(sid.expires, 1893456000);
});

ok('seller export: sameSite mapped case-insensitively, null omitted', () => {
  const sid = sellerState.cookies.find((c) => c.name === 'sessionid');
  assert.strictEqual(sid.sameSite, 'None'); // no_restriction -> None
  const csrf = sellerState.cookies.find((c) => c.name === 'csrftoken');
  assert.ok(!('sameSite' in csrf), 'null sameSite should be omitted');
  const ds = sellerState.cookies.find((c) => c.name === 'ds_user_id');
  assert.strictEqual(ds.sameSite, 'Lax'); // LAX -> Lax
  const mid = sellerState.cookies.find((c) => c.name === 'mid');
  assert.strictEqual(mid.sameSite, 'Strict');
});

ok('seller export: non-Playwright fields dropped (hostOnly/session/storeId)', () => {
  for (const c of sellerState.cookies) {
    assert.ok(!('hostOnly' in c), 'hostOnly leaked');
    assert.ok(!('session' in c), 'session leaked');
    assert.ok(!('storeId' in c), 'storeId leaked');
    assert.ok(!('expirationDate' in c), 'expirationDate leaked');
  }
});

ok('seller export hygiene: summary contains no fake sessionid value', () => {
  const blob = JSON.stringify(sessionStore.summarizeState(sellerState));
  assert.ok(!blob.includes(FAKE_SESSION_ID), 'sessionid value leaked');
  assert.ok(!blob.includes(FAKE_CSRF), 'csrftoken value leaked');
});

// ---- Base64 包装的会话文件（卖家把整份 cookie JSON 再编码一层） ----
const B64_COOKIES = [
  { name: 'sessionid', value: FAKE_SESSION_ID, domain: '.instagram.com', path: '/', expirationDate: 1893456000, httpOnly: true, secure: true },
  { name: 'csrftoken', value: FAKE_CSRF, domain: '.instagram.com' },
  { name: 'ds_user_id', value: '1234567890', domain: '.instagram.com', path: '/' },
  // 探针值含 '>' 与 '?'，保证标准 Base64 里必然出现 '+' 与 '/'（给 base64url 映射测试用）
  { name: 'probe', value: '>>>???', domain: '.instagram.com', path: '/' },
];
const B64_JSON = JSON.stringify(B64_COOKIES);
const B64_TEXT = Buffer.from(B64_JSON, 'utf8').toString('base64');

ok('base64: label line + base64(JSON array) on one line parses, sessionid found', () => {
  const st = sessionStore.parseSessionText('卖家导出 base64 版（这一行是标题）\n' + B64_TEXT);
  assert.strictEqual(st.cookies.length, 4);
  assert.ok(sessionStore.hasCookie(st, 'sessionid'));
});

ok('base64: wrapped at 64-char lines parses', () => {
  const wrapped = B64_TEXT.match(/.{1,64}/g).join('\n');
  const st = sessionStore.parseSessionText('标题行\n' + wrapped);
  assert.strictEqual(st.cookies.length, 4);
  assert.ok(sessionStore.hasCookie(st, 'sessionid'));
});

ok('base64url: url-safe alphabet, padding stripped, parses and probe value intact', () => {
  assert.ok(/[+/]/.test(B64_TEXT), 'test setup: standard base64 should contain + or /');
  const urlVariant = B64_TEXT.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const st = sessionStore.parseSessionText(urlVariant);
  assert.strictEqual(st.cookies.length, 4);
  assert.ok(sessionStore.hasCookie(st, 'sessionid'));
  const probe = st.cookies.find((c) => c.name === 'probe');
  assert.strictEqual(probe.value, '>>>???');
});

ok('base64 hygiene: error messages contain no fake cookie value', () => {
  const outputs = [];
  // 不是 JSON 也不是 Base64 的垃圾文本
  try { sessionStore.parseSessionText('%%% 都不是，就一段乱码 %%%'); } catch (e) { outputs.push(e.message); }
  // Base64 解开后不是 JSON
  try { sessionStore.parseSessionText(Buffer.from('hello world, not json', 'utf8').toString('base64')); } catch (e) { outputs.push(e.message); }
  // Base64 解开是 JSON 数组但缺 sessionid（里面含假 csrftoken 值）——报错只点名，不带值
  const noSid = Buffer.from(JSON.stringify([{ name: 'csrftoken', value: FAKE_CSRF, domain: '.instagram.com' }]), 'utf8').toString('base64');
  let namedErr = null;
  try { sessionStore.parseSessionText(noSid); } catch (e) { namedErr = e; outputs.push(e.message); }
  assert.ok(namedErr && namedErr.message.includes('sessionid'), 'should name sessionid');
  const blob = outputs.join('\n');
  assert.ok(blob.length > 0, 'should have collected error messages');
  assert.ok(!blob.includes(FAKE_SESSION_ID), 'sessionid value leaked into error');
  assert.ok(!blob.includes(FAKE_CSRF), 'csrftoken value leaked into error');
});

console.log('会话文件单测全部通过：' + passed + ' 项');
