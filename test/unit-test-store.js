'use strict';
// 累积存储单测：纯本地、不联网、不开浏览器。
// 覆盖：两轮合并去重、同一线索跨关键词的 keywords 累积、帖子跳过判定、
// 存储文件损坏/缺失的容错、0600 权限、以及 saveOutput 全链路
// （本轮 CSV 跨关键词合并 + 累积 CSV + store 落盘）在临时目录里的冒烟。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const storeMod = require('../src/store');
const config = require('../config');
const { saveOutput } = require('../collector');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-store-test-'));
const storeFile = path.join(tmpDir, 'store.json');
const P1 = 'https://www.instagram.com/p/AAA111/';
const P2 = 'https://www.instagram.com/p/BBB222/';
const P3 = 'https://www.instagram.com/reel/CCC333/';

ok('missing file → empty store, missing flag', () => {
  const r = storeMod.loadStore(storeFile);
  assert.strictEqual(r.missing, true);
  assert.strictEqual(r.corrupt, false);
  assert.deepStrictEqual(storeMod.statsOf(r.store), { posts: 0, leads: 0, users: 0 });
  assert.strictEqual(storeMod.hasPost(r.store, P1), false);
});

let store = storeMod.loadStore(storeFile).store;
ok('run1 merge: posts + leads counted', () => {
  const m = storeMod.mergeRun(store, {
    now: '2026-11-12T00:00:00.000Z',
    posts: [
      { postUrl: P1, keyword: 'downjacket', checkedAt: '2026-11-12T00:00:00.000Z' },
      { postUrl: P2, keyword: 'downjacket', checkedAt: '2026-11-12T00:00:00.000Z' },
    ],
    leads: [
      { username: 'alice', comment: 'how much?', keyword: 'downjacket' },
      { username: 'bob', comment: 'price please', keyword: 'downjacket' },
    ],
  });
  assert.deepStrictEqual(m, { addedPosts: 2, addedLeads: 2 });
  assert.strictEqual(storeMod.hasPost(store, P1), true);
  assert.strictEqual(storeMod.hasPost(store, P3), false);
  assert.deepStrictEqual(storeMod.statsOf(store), { posts: 2, leads: 2, users: 2 });
});

ok('save + reload roundtrip keeps data', () => {
  storeMod.saveStore(storeFile, store);
  const r = storeMod.loadStore(storeFile);
  assert.strictEqual(r.corrupt, false);
  assert.deepStrictEqual(storeMod.statsOf(r.store), { posts: 2, leads: 2, users: 2 });
  store = r.store;
});

ok('run2 merge: dedupe across runs + keyword accumulation on repeated lead', () => {
  const m = storeMod.mergeRun(store, {
    now: '2026-11-13T00:00:00.000Z',
    posts: [
      { postUrl: P2, keyword: 'bags', checkedAt: '2026-11-13T00:00:00.000Z' }, // 已有，不新增
      { postUrl: P3, keyword: 'bags', checkedAt: '2026-11-13T00:00:00.000Z' }, // 新增
    ],
    leads: [
      { username: 'alice', comment: 'how much?', keyword: 'bags' }, // 同一条线索，关键词累积
      { username: 'alice', comment: 'do you ship?', keyword: 'bags' }, // alice 的新评论，新增
    ],
  });
  assert.deepStrictEqual(m, { addedPosts: 1, addedLeads: 1 });
  const key = storeMod.leadKey('alice', 'how much?');
  assert.deepStrictEqual(store.leads[key].keywords, ['downjacket', 'bags']);
  assert.strictEqual(store.leads[key].firstSeenAt, '2026-11-12T00:00:00.000Z'); // 首次时间为准
  assert.deepStrictEqual(storeMod.statsOf(store), { posts: 3, leads: 3, users: 2 });
});

ok('leadsRows: insertion order + profileUrl shape', () => {
  const rows = storeMod.leadsRows(store);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].profileUrl, 'https://www.instagram.com/alice/');
  assert.strictEqual(rows[0].comment, 'how much?');
  assert.strictEqual(rows[1].profileUrl, 'https://www.instagram.com/bob/');
});

ok('corrupt file → empty store + corrupt flag (garbage and wrong shape)', () => {
  fs.writeFileSync(storeFile, 'this is not json{{{', 'utf8');
  let r = storeMod.loadStore(storeFile);
  assert.strictEqual(r.corrupt, true);
  assert.deepStrictEqual(storeMod.statsOf(r.store), { posts: 0, leads: 0, users: 0 });
  fs.writeFileSync(storeFile, '{"hello": 1}', 'utf8');
  r = storeMod.loadStore(storeFile);
  assert.strictEqual(r.corrupt, true);
});

if (process.platform !== 'win32') {
  ok('saved store file has 0600 permissions', () => {
    storeMod.saveStore(storeFile, storeMod.emptyStore());
    const mode = fs.statSync(storeFile).mode & 0o777;
    assert.strictEqual(mode, 0o600);
  });
}

// ---- saveOutput 全链路冒烟（临时目录 + 临时存储，config 指过去再指回来）----
ok('saveOutput: multi-keyword run merges into store, per-run CSV dedupes across keywords', () => {
  const outDir = path.join(tmpDir, 'out');
  const realStoreFile = path.join(tmpDir, 'real-store.json');
  const origOut = config.outDir;
  const origStore = config.storeFile;
  config.outDir = outDir;
  config.storeFile = realStoreFile;
  try {
    const st = storeMod.emptyStore();
    const output = {
      keyword: 'downjacket',
      keywords: ['downjacket', 'bags'],
      items: [
        {
          ownerUsername: 'shop_a', keyword: 'downjacket',
          latestComments: [
            { ownerUsername: 'alice', text: 'how much?', intentTypes: ['问价格'] },
            { ownerUsername: 'shop_a', text: 'DM to order', intentTypes: ['问购买'] }, // 自评，剔除
          ],
        },
        {
          ownerUsername: 'shop_b', keyword: 'bags',
          latestComments: [
            { ownerUsername: 'alice', text: 'how much?', intentTypes: ['问价格'] }, // 跨词同一句，去重
            { ownerUsername: 'carol', text: 'ship to Canada?', intentTypes: ['问运费'] },
          ],
        },
      ],
    };
    const saved = saveOutput(output, {
      storeState: st,
      checkedPosts: [
        { postUrl: P1, keyword: 'downjacket', checkedAt: '2026-11-12T01:00:00.000Z' },
        { postUrl: P3, keyword: 'bags', checkedAt: '2026-11-12T01:00:00.000Z' },
      ],
      fileTag: 'downjacket_bags',
    });
    assert.strictEqual(saved.leadsCount, 2); // alice 一条 + carol 一条
    assert.ok(fs.existsSync(saved.file) && saved.file.includes('collect-downjacket_bags-'));
    assert.ok(fs.existsSync(saved.leadsFile));
    assert.ok(saved.allFile && fs.existsSync(saved.allFile));
    assert.strictEqual(saved.allCount, 2);
    assert.strictEqual(saved.addedPosts, 2);
    assert.strictEqual(saved.addedLeads, 2);
    const perRun = fs.readFileSync(saved.leadsFile, 'utf8');
    assert.ok(perRun.startsWith('\uFEFF用户链接,评论内容'));
    assert.strictEqual((perRun.match(/alice/g) || []).length, 1);
    const onDisk = storeMod.loadStore(realStoreFile);
    assert.strictEqual(onDisk.corrupt, false);
    const key = storeMod.leadKey('alice', 'how much?');
    assert.deepStrictEqual(onDisk.store.leads[key].keywords, ['downjacket', 'bags']);
    assert.strictEqual(storeMod.hasPost(onDisk.store, P3), true);
  } finally {
    config.outDir = origOut;
    config.storeFile = origStore;
  }
});

console.log('累积存储单测全部通过：' + passed + ' 项');
