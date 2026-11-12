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
    assert.strictEqual(loaded.unparseable.find((u) => u.file === 'b.txt').reason, '读不出（格式不认）');
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

// ---- 第二组：新格式 + 新原因类别（UTF-16 文件、Cookie 头、空文件、Netscape 缺 sessionid）----
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-cookiesdir-test2-'));
try {
  // UTF-16LE（带 BOM）存的 JSON —— 记事本另存的典型产物，按字节读才能解
  const utf16Json = JSON.stringify([
    { name: 'sessionid', value: FAKE_ID_1, domain: '.instagram.com', path: '/' },
    { name: 'csrftoken', value: FAKE_CSRF, domain: '.instagram.com' },
  ]);
  fs.writeFileSync(path.join(dir2, 'utf16.txt'),
    Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(utf16Json, 'utf16le')]));
  // Cookie 头单行
  fs.writeFileSync(path.join(dir2, 'header.txt'),
    'sessionid=' + FAKE_ID_1 + '; csrftoken=' + FAKE_CSRF + '; ds_user_id=1234567890', 'utf8');
  // 空文件
  fs.writeFileSync(path.join(dir2, 'empty.txt'), '', 'utf8');
  // Netscape 格式但只有 csrftoken / datr，没有 sessionid
  const nsLine = (name, value) => ['.instagram.com', 'TRUE', '/', 'TRUE', '1893456000', name, value].join('\t');
  fs.writeFileSync(path.join(dir2, 'netscape-nosid.txt'),
    '# Netscape HTTP Cookie File\n' + nsLine('csrftoken', FAKE_CSRF) + '\n' + nsLine('datr', 'fake-datr') + '\n', 'utf8');

  let loaded2 = null;
  ok('load2: utf16 + cookie-header files are parseable', () => {
    loaded2 = cookiesDir.loadCandidates(dir2);
    assert.deepStrictEqual(loaded2.parseable.map((c) => c.file), ['header.txt', 'utf16.txt']);
  });

  ok('load2: reasons are granular — 空文件 / 像Netscape格式但没有sessionid', () => {
    assert.deepStrictEqual(loaded2.unparseable.map((u) => u.file), ['empty.txt', 'netscape-nosid.txt']);
    assert.strictEqual(loaded2.unparseable.find((u) => u.file === 'empty.txt').reason, '空文件');
    assert.strictEqual(loaded2.unparseable.find((u) => u.file === 'netscape-nosid.txt').reason,
      '像Netscape格式但没有sessionid');
  });

  ok('diagnose: values-free report with format label and names only', () => {
    const dGood = cookiesDir.diagnoseFile(path.join(dir2, 'utf16.txt'));
    assert.strictEqual(dGood.ok, true);
    assert.strictEqual(dGood.format, 'json数组');
    assert.deepStrictEqual(dGood.cookieNames, ['csrftoken', 'sessionid']);
    const dNs = cookiesDir.diagnoseFile(path.join(dir2, 'netscape-nosid.txt'));
    assert.strictEqual(dNs.ok, false);
    assert.strictEqual(dNs.format, 'netscape');
    assert.strictEqual(dNs.hasSessionid, false);
    assert.strictEqual(dNs.reason, '像Netscape格式但没有sessionid');
    const blob = JSON.stringify([dGood, dNs]);
    assert.ok(!blob.includes(FAKE_ID_1), 'sessionid value leaked into diagnose');
    assert.ok(!blob.includes(FAKE_CSRF), 'csrftoken value leaked into diagnose');
    assert.ok(!blob.includes('fake-datr'), 'datr value leaked into diagnose');
  });
} finally {
  fs.rmSync(dir2, { recursive: true, force: true });
}

console.log('cookies 文件夹单测全部通过：' + passed + ' 项');
