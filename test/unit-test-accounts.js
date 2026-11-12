'use strict';
// 账号文件 + TOTP 单测：只用虚构假数据，不联网、不登录、不开浏览器。
// 重点：字段切分、缺省列容忍、黑名单拒绝、秘密绝不出现在任何输出里、
// TOTP 对 RFC 6238 官方测试向量。
const assert = require('assert');
const accounts = require('../src/accounts');
const { generateTotp, base32Decode } = require('../src/totp');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

const FAKE_TEXT = [
  '# 这是注释行，应该被跳过',
  '',
  'sample_small_a----fakePass123----a@example.com----JBSWY3DPEHPK3PXP',
  'sample_small_b----fakePass456',
  'nataliem.jordan----fakePass789----c@example.com----JBSWY3DPEHPK3PXP',
  'LEAKCHECK99',
].join('\n');

const parsed = accounts.parseAccountsText(FAKE_TEXT);

ok('parse: 3 valid accounts, comment/blank skipped', () => {
  assert.strictEqual(parsed.accounts.length, 3);
});
ok('parse: full row fields split correctly', () => {
  const a = parsed.accounts[0];
  assert.strictEqual(a.username, 'sample_small_a');
  assert.strictEqual(a.password, 'fakePass123');
  assert.strictEqual(a.email, 'a@example.com');
  assert.strictEqual(a.totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.strictEqual(a.blocked, false);
});
ok('parse: missing optional columns tolerated', () => {
  const b = parsed.accounts[1];
  assert.strictEqual(b.username, 'sample_small_b');
  assert.strictEqual(b.email, '');
  assert.strictEqual(b.totpSecret, '');
});
ok('parse: blocked line is flagged at parse time', () => {
  const c = parsed.accounts[2];
  assert.strictEqual(c.username, 'nataliem.jordan');
  assert.strictEqual(c.blocked, true);
});
ok('select: normal account selected (case-insensitive)', () => {
  const sel = accounts.selectAccount(parsed.accounts, 'Sample_Small_A');
  assert.ok(sel.account);
  assert.strictEqual(sel.account.username, 'sample_small_a');
});
ok('select: blocklist account refused', () => {
  const sel = accounts.selectAccount(parsed.accounts, 'nataliem.jordan');
  assert.strictEqual(sel.error, 'blocked');
});
ok('select: unknown account not found', () => {
  const sel = accounts.selectAccount(parsed.accounts, 'nobody_here');
  assert.strictEqual(sel.error, 'not_found');
});

// ---- 秘密卫生：所有可能被打印/记录的内容里都不许出现假密码和假密钥 ----
ok('hygiene: no secrets in warnings / public views / username list', () => {
  const outputs = [];
  outputs.push(JSON.stringify(parsed.warnings));
  outputs.push(JSON.stringify(parsed.accounts.map(accounts.publicView)));
  outputs.push(accounts.listUsernames(parsed.accounts).join('\n'));
  outputs.push(JSON.stringify(accounts.selectAccount(parsed.accounts, 'nobody_here')));
  const blob = outputs.join('\n');
  assert.ok(!blob.includes('fakePass123'), 'password leaked into output');
  assert.ok(!blob.includes('fakePass456'), 'password leaked into output');
  assert.ok(!blob.includes('fakePass789'), 'password leaked into output');
  assert.ok(!blob.includes('JBSWY3DPEHPK3PXP'), 'totp secret leaked into output');
  assert.ok(!blob.includes('LEAKCHECK99'), 'malformed raw line leaked into warnings');
});

// ---- TOTP：RFC 6238 官方测试向量 ----
// 官方种子 ASCII "12345678901234567890"，base32 编码如下；
// T=59s 时 SHA1 8 位码为 94287082（RFC 6238 附录 B），取 6 位 = 287082；
// T=1111111109s 时 SHA1 8 位码为 07081804，取 6 位 = 081804（已用 Python hmac 独立复算一致）；
// T=1234567890s 时 8 位码为 89005924，取 6 位 = 005924。
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
ok('totp: base32 decode matches RFC seed bytes', () => {
  assert.strictEqual(base32Decode(RFC_SECRET_B32).toString('ascii'), '12345678901234567890');
});
ok('totp: RFC 6238 vector T=59s -> 287082', () => {
  assert.strictEqual(generateTotp(RFC_SECRET_B32, { timestampMs: 59000 }), '287082');
});
ok('totp: RFC 6238 vector T=1111111109s -> 081804', () => {
  assert.strictEqual(generateTotp(RFC_SECRET_B32, { timestampMs: 1111111109000 }), '081804');
});
ok('totp: RFC 6238 vector T=1234567890s -> 005924', () => {
  assert.strictEqual(generateTotp(RFC_SECRET_B32, { timestampMs: 1234567890000 }), '005924');
});
ok('totp: always 6 digits and changes across windows', () => {
  const c1 = generateTotp('JBSWY3DPEHPK3PXP', { timestampMs: 1700000000000 });
  const c2 = generateTotp('JBSWY3DPEHPK3PXP', { timestampMs: 1700000000000 + 30000 * 17 });
  assert.ok(/^\d{6}$/.test(c1), 'not 6 digits: ' + c1);
  assert.ok(/^\d{6}$/.test(c2), 'not 6 digits: ' + c2);
  assert.notStrictEqual(c1, c2);
});

console.log('账号/TOTP 单测全部通过：' + passed + ' 项');
