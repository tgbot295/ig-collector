'use strict';
// 浏览器启动策略单测：只用虚构假启动函数，不联网、不开真浏览器。
// 重点：候选顺序 Chrome→Edge→自带 Chromium、成功即停不试后面、
// 强制选择只试那一个、全失败聚合错误只含三个名字（不带底层错误原文/堆栈）。
const assert = require('assert');
const browserLaunch = require('../src/browserLaunch');

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed++;
  console.log('PASS ' + name);
}

(async () => {
  ok('candidates: default order is chrome, msedge, chromium', () => {
    assert.deepStrictEqual(browserLaunch.buildCandidates().map((c) => c.key),
      ['chrome', 'msedge', 'chromium']);
    assert.deepStrictEqual(browserLaunch.buildCandidates('').map((c) => c.key),
      ['chrome', 'msedge', 'chromium']);
  });

  ok('candidates: forced choice returns only that one; invalid returns empty', () => {
    assert.deepStrictEqual(browserLaunch.buildCandidates('msedge').map((c) => c.key), ['msedge']);
    assert.deepStrictEqual(browserLaunch.buildCandidates(' Chrome ').map((c) => c.key), ['chrome']);
    assert.deepStrictEqual(browserLaunch.buildCandidates('firefox'), []);
    assert.ok(browserLaunch.isValidChoice('chromium'));
    assert.ok(!browserLaunch.isValidChoice('firefox'));
  });

  await ok('tryLaunch: chrome succeeds → edge/chromium never called', async () => {
    const calls = [];
    const fn = async (cand) => { calls.push(cand.key); return { fake: cand.key }; };
    const out = await browserLaunch.tryLaunch(fn);
    assert.deepStrictEqual(calls, ['chrome']);
    assert.strictEqual(out.candidate.key, 'chrome');
    assert.strictEqual(out.result.fake, 'chrome');
  });

  await ok('tryLaunch: chrome throws, edge succeeds → chromium never called', async () => {
    const calls = [];
    const fn = async (cand) => {
      calls.push(cand.key);
      if (cand.key === 'chrome') throw new Error('chrome not installed (fake)');
      return { fake: cand.key };
    };
    const out = await browserLaunch.tryLaunch(fn);
    assert.deepStrictEqual(calls, ['chrome', 'msedge']);
    assert.strictEqual(out.candidate.key, 'msedge');
  });

  await ok('tryLaunch: all throw → aggregate error names all three, no underlying text', async () => {
    const SECRET = 'FAKESTACKSECRET999';
    const fn = async () => { throw new Error('boom ' + SECRET + '\nstack line 2 ' + SECRET); };
    let err = null;
    try { await browserLaunch.tryLaunch(fn); } catch (e) { err = e; }
    assert.ok(err, 'should throw');
    assert.ok(err.message.includes('Google Chrome'), 'names chrome');
    assert.ok(err.message.includes('Microsoft Edge'), 'names edge');
    assert.ok(err.message.includes('Chromium'), 'names chromium');
    assert.ok(!err.message.includes(SECRET), 'aggregate message must not carry underlying error text');
    assert.ok(!err.message.includes('\n'), 'aggregate message is single-line');
    assert.strictEqual(err.failures.length, 3);
    assert.ok(err.failures.every((f) => !f.includes('\n')), 'each failure reason is one line');
  });

  await ok('tryLaunch: forced msedge only tries msedge', async () => {
    const calls = [];
    const fn = async (cand) => { calls.push(cand.key); return { fake: 1 }; };
    const out = await browserLaunch.tryLaunch(fn, 'msedge');
    assert.deepStrictEqual(calls, ['msedge']);
    assert.strictEqual(out.candidate.key, 'msedge');
  });

  await ok('tryLaunch: invalid forced choice throws before any launch', async () => {
    let called = false;
    const fn = async () => { called = true; return {}; };
    await assert.rejects(() => browserLaunch.tryLaunch(fn, 'firefox'));
    assert.strictEqual(called, false);
  });

  await ok('withChannel: chrome/msedge add channel, chromium leaves none', () => {
    const byKey = {};
    for (const c of browserLaunch.CANDIDATES) byKey[c.key] = c;
    assert.strictEqual(browserLaunch.withChannel({ headless: false }, byKey.chrome).channel, 'chrome');
    assert.strictEqual(browserLaunch.withChannel({ headless: false }, byKey.msedge).channel, 'msedge');
    const bare = browserLaunch.withChannel({ headless: true, channel: 'chrome' }, byKey.chromium);
    assert.ok(!('channel' in bare), 'chromium candidate must not carry a channel');
    assert.strictEqual(bare.headless, true);
  });

  console.log('浏览器启动策略单测全部通过：' + passed + ' 项');
})().catch((e) => {
  console.error('FAIL ' + (e && e.message ? e.message : e));
  process.exit(1);
});
