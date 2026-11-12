'use strict';
// --check-cookies 冒烟测试：子进程真跑 collector.js 的体检模式，
// 只用虚构假数据。断言：退出码 0、每个文件一行结论（格式/cookie 名字/
// 有没有 sessionid），且输出里绝不出现任何假 cookie 的值。
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

const FAKE_ID = 'FAKESESSIONID123';
const FAKE_CSRF = 'FAKECSRFTOKEN456';
const collectorPath = path.join(__dirname, '..', 'collector.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-check-cookies-'));
let out = '';
try {
  // 可用的 JSON 数组文件
  fs.writeFileSync(path.join(dir, 'good.txt'), JSON.stringify([
    { name: 'sessionid', value: FAKE_ID, domain: '.instagram.com', path: '/' },
    { name: 'csrftoken', value: FAKE_CSRF, domain: '.instagram.com' },
  ]), 'utf8');
  // 带空格括号的文件名（跟用户真实的 details (9).txt 一个形状）+ Netscape 内容
  const nsLine = (name, value) => ['.instagram.com', 'TRUE', '/', 'TRUE', '1893456000', name, value].join('\t');
  fs.writeFileSync(path.join(dir, 'details (9).txt'), [
    '# Netscape HTTP Cookie File',
    '#HttpOnly_' + nsLine('sessionid', FAKE_ID),
    nsLine('csrftoken', FAKE_CSRF),
    nsLine('ds_user_id', '1234567890'),
  ].join('\n'), 'utf8');
  // 垃圾文件
  fs.writeFileSync(path.join(dir, 'bad.txt'), '这不是 cookie %%%', 'utf8');

  ok('check-cookies: exits 0 and reports per-file verdicts, names only', () => {
    out = execFileSync(process.execPath, [collectorPath, '--check-cookies', '--cookies-dir', dir],
      { encoding: 'utf8' });
    assert.ok(out.includes('[可用] good.txt'), 'good.txt should be usable');
    assert.ok(out.includes('[可用] details (9).txt'), 'details (9).txt should be usable');
    assert.ok(out.includes('格式：netscape'), 'netscape format should be named');
    assert.ok(out.includes('格式：json数组'), 'json format should be named');
    assert.ok(out.includes('sessionid：有'), 'sessionid presence should be reported');
    assert.ok(out.includes('[不可用] bad.txt'), 'bad.txt should be unusable');
    assert.ok(out.includes('sessionid'), 'cookie names should be listed');
  });

  ok('check-cookies hygiene: no fake cookie value in stdout', () => {
    assert.ok(!out.includes(FAKE_ID), 'sessionid value leaked into stdout');
    assert.ok(!out.includes(FAKE_CSRF), 'csrftoken value leaked into stdout');
  });

  ok('check-cookies: empty dir still exits 0 with guidance', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-check-cookies-empty-'));
    try {
      const out2 = execFileSync(process.execPath, [collectorPath, '--check-cookies', '--cookies-dir', emptyDir],
        { encoding: 'utf8' });
      assert.ok(out2.includes('一个文件都没找到'));
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('--check-cookies 冒烟测试全部通过：' + passed + ' 项');
