'use strict';
// 图形控制台单测：纯本地。用注入的假 runner 起一个真 http 服务（随机端口），
// 全程不碰浏览器、不碰 IG：验页面、日志流、停止标志、并发 409、
// 统计接口和两种导出（数据来自预先种好的临时累积存储）。
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const storeMod = require('../src/store');
const { createGuiServer } = require('../src/gui');

let passed = 0;
function ok(name, fn) {
  passed++;
  console.log('PASS ' + name);
  return fn;
}

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request(
      { host: '127.0.0.1', port: port, path: p, method: method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 预种累积存储：1 帖、2 条线索、2 个用户
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-gui-test-'));
  const storeFile = path.join(tmpDir, 'store.json');
  const seed = storeMod.emptyStore();
  storeMod.mergeRun(seed, {
    now: '2026-11-12T00:00:00.000Z',
    posts: [{ postUrl: 'https://www.instagram.com/p/AAA111/', keyword: 'downjacket', checkedAt: '2026-11-12T00:00:00.000Z' }],
    leads: [
      { username: 'alice', comment: 'how much?', keyword: 'downjacket' },
      { username: 'bob', comment: 'ship to Canada?', keyword: 'downjacket' },
    ],
  });
  storeMod.saveStore(storeFile, seed);

  // 假 runner：记下收到的参数和 control，写两行日志，然后卡在 gate 上等放行
  let captured = null;
  let releaseGate = null;
  const gate = new Promise((r) => { releaseGate = r; });
  const fakeRunner = async (runOpts, control) => {
    captured = { runOpts: runOpts, control: control };
    runOpts.log('假日志第一行');
    runOpts.log('假日志：关键词 ' + runOpts.keywords.join('、'));
    await gate;
    runOpts.log(control.stopFlag.stopped ? '假日志：已按停止标志收尾' : '假日志：正常跑完');
  };

  const handle = createGuiServer({ port: 0, storeFile: storeFile, runner: fakeRunner });
  await new Promise((r) => handle.server.on('listening', r));
  const port = handle.server.address().port;
  assert.ok(port > 0);

  try {
    // 1) 首页
    let res = await req(port, 'GET', '/');
    assert.strictEqual(res.status, 200);
    const html = res.body.toString('utf8');
    assert.ok(html.includes('IG采集控制台'), '页面标题不对');
    assert.ok(html.includes('downjacket'), '关键词框应预填 downjacket');
    assert.ok(html.includes('/api/export.xlsx') && html.includes('/api/export.csv'));
    ok('GET / returns the console page', () => {});

    // 2) 统计
    res = await req(port, 'GET', '/api/stats');
    assert.deepStrictEqual(JSON.parse(res.body.toString('utf8')), { posts: 1, leads: 2, users: 2 });
    ok('GET /api/stats reads the seeded store', () => {});

    // 3) CSV 导出：BOM + 两列 + 种子数据
    res = await req(port, 'GET', '/api/export.csv');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body[0], 0xef);
    assert.strictEqual(res.body[1], 0xbb);
    assert.strictEqual(res.body[2], 0xbf);
    const csv = res.body.toString('utf8');
    assert.ok(csv.includes('用户链接,评论内容'));
    assert.ok(csv.includes('https://www.instagram.com/alice/,how much?'));
    ok('GET /api/export.csv returns BOM two-column CSV from store', () => {});

    // 4) XLSX 导出：是个 ZIP 包
    res = await req(port, 'GET', '/api/export.xlsx');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.toString('ascii', 0, 2), 'PK');
    ok('GET /api/export.xlsx returns an xlsx (zip) payload', () => {});

    // 5) 启动一轮（假 runner 接住）
    res = await req(port, 'POST', '/api/start', { keywords: ['downjacket', 'bags'], posts: 5 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(JSON.parse(res.body.toString('utf8')).ok, true);
    await sleep(50);
    assert.ok(captured, 'runner 没有被调用');
    assert.deepStrictEqual(captured.runOpts.keywords, ['downjacket', 'bags']);
    assert.strictEqual(captured.runOpts.posts, 5);
    assert.strictEqual(captured.control.stopFlag.stopped, false);
    ok('POST /api/start invokes the injected runner with keywords+posts', () => {});

    // 6) 并发再启动 → 409
    res = await req(port, 'POST', '/api/start', { keywords: ['other'], posts: 5 });
    assert.strictEqual(res.status, 409);
    ok('second concurrent POST /api/start → 409', () => {});

    // 7) 日志流能捞到 runner 写的话
    res = await req(port, 'GET', '/api/log?since=0');
    const logData = JSON.parse(res.body.toString('utf8'));
    assert.ok(logData.lines.some((l) => l.includes('假日志第一行')));
    assert.ok(logData.lines.some((l) => l.includes('downjacket、bags')));
    assert.ok(logData.total >= logData.lines.length);
    ok('GET /api/log streams runner log lines', () => {});

    // 8) 停止按钮翻标志
    res = await req(port, 'POST', '/api/stop', {});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(captured.control.stopFlag.stopped, true);
    ok('POST /api/stop flips the run stop flag', () => {});

    // 9) 放行后运行结束，state 回到空闲，还能再启动
    releaseGate();
    for (let i = 0; i < 40; i++) {
      res = await req(port, 'GET', '/api/state');
      if (JSON.parse(res.body.toString('utf8')).running === false) break;
      await sleep(50);
    }
    assert.strictEqual(JSON.parse(res.body.toString('utf8')).running, false);
    ok('run finishes and state returns to idle', () => {});
  } finally {
    await handle.close();
  }

  console.log('图形控制台单测全部通过：' + passed + ' 项');
}

main().catch((e) => {
  console.error('图形控制台单测失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
