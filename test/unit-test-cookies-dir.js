'use strict';
// cookies/ 文件夹自动扫描单测：只用虚构假数据，不联网、不登录、不开浏览器。
// 重点：文件名随便（可无扩展名）都收、按文件名排序、说明文件/点文件/子目录排除、
// 纯 JSON 与 Base64 包装都能解、解不出的只报文件名+原因类别、任何输出不含假 cookie 值。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cookiesDir = require('../src/cookiesDir');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

const FAKE_ID_1 = 'FAKESESSIONID123';
const FAKE_ID_2 = 'FAKESESSIONIDB64XYZ';
const FAKE_CSRF = 'FAKECSRFTOKEN456';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-cookiesdir-test-'));
try {
  const validJson = JSON.stringify([
    { name: 'sessionid', value: FAKE_ID_1, domain: '.instagram.com', path: '/' },
    { name: 'csrftoken', value: FAKE_CSRF, domain: '.instagram.com' },
  ]);
  // 无扩展名、纯数字文件名 —— 用户的真实用法（“1234”）
  fs.writeFileSync(path.join(dir, '1234'), validJson, 'utf8');
  // Base64 包装 + 卖家标题行
  const b64 = Buffer.from(JSON.stringify([
    { name: 'sessionid', value: FAKE_ID_2, domain: '.instagram.com', path: '/' },
    { name: 'csrftoken', value: FAKE_CSRF, domain: '.instagram.com' },
  ]), 'utf8').toString('base64');
  fs.writeFileSync(path.join(dir, 'a.txt'), '卖家导出文件（标题行）\n' + b64, 'utf8');
  // 垃圾内容
  fs.writeFileSync(path.join(dir, 'b.txt'), '这不是 cookie，就是一段乱写 %%%', 'utf8');
  // 合法 JSON 但缺 sessionid
  fs.writeFileSync(path.join(dir, 'c.txt'), JSON.stringify([
    { name: 'csrftoken', value: FAKE_CSRF, domain: '.instagram.com' },
  ]), 'utf8');
  // 应排除的三类：说明文件、点文件、子目录（子目录里放合法文件也不收）
  fs.writeFileSync(path.join(dir, cookiesDir.PLACEHOLDER_NAME), '占位说明', 'utf8');
  fs.writeFileSync(path.join(dir, '.hidden'), validJson, 'utf8');
  fs.mkdirSync(path.join(dir, 'subdir'));
  fs.writeFileSync(path.join(dir, 'subdir', 'inner.txt'), validJson, 'utf8');

  let scan = null;
  ok('scan: candidates sorted, placeholder/dotfile/subdir excluded', () => {
    scan = cookiesDir.scanCookiesDir(dir);
    assert.deepStrictEqual(scan.map((c) => c.file), ['1234', 'a.txt', 'b.txt', 'c.txt']);
    assert.ok(scan.every((c) => c.fullPath.startsWith(dir)));
  });

  let loaded = null;
  ok('load: parseable = {1234, a.txt} in sorted order, both carry sessionid', () => {
    loaded = cookiesDir.loadCandidates(dir);
    assert.deepStrictEqual(loaded.parseable.map((c) => c.file), ['1234', 'a.txt']);
    for (const c of loaded.parseable) {
      assert.ok(c.storageState && Array.isArray(c.storageState.cookies));
      assert.ok(c.storageState.cookies.some((k) => k.name === 'sessionid'));
    }
  });

  ok('load: unparseable reported by filename + reason category only', () => {
    assert.deepStrictEqual(loaded.unparseable.map((u) => u.file), ['b.txt', 'c.txt']);
    assert.strictEqual(loaded.unparseable.find((u) => u.file === 'b.txt').reason, '读不出');
    assert.strictEqual(loaded.unparseable.find((u) => u.file === 'c.txt').reason, '没有sessionid');
  });

  ok('scan/load: missing dir returns empty, no throw', () => {
    const missing = path.join(dir, 'no-such-dir');
    assert.deepStrictEqual(cookiesDir.scanCookiesDir(missing), []);
    assert.deepStrictEqual(cookiesDir.loadCandidates(missing), { parseable: [], unparseable: [] });
  });

  ok('hygiene: filename/reason report contains no fake cookie values', () => {
    const blob = JSON.stringify({
      scan: scan.map((c) => c.file),
      parseable: loaded.parseable.map((c) => c.file),
      unparseable: loaded.unparseable,
      categories: [cookiesDir.reasonCategory(new Error('x')), cookiesDir.reasonCategory(null)],
    });
    assert.ok(!blob.includes(FAKE_ID_1), 'sessionid value leaked');
    assert.ok(!blob.includes(FAKE_ID_2), 'sessionid value leaked');
    assert.ok(!blob.includes(FAKE_CSRF), 'csrftoken value leaked');
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('cookies 文件夹单测全部通过：' + passed + ' 项');
