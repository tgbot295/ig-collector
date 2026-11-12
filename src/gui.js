'use strict';
// 图形控制台（本地网页版控制面板）：等价于隔壁 Python 工具的 Tkinter 窗口，
// 但用 Node 自带的 http 服务实现，零依赖、零外部资源：
//   node collector.js --gui → 在 127.0.0.1:3212 打开一个控制台页面，
//   填关键词、点「开始采集」，日志实时滚，统计卡看累积数据，一键导出
//   Excel / CSV。浏览器只在本机回环地址上开放，拒绝绑任何外部地址。
//
// 采集不在这个文件里发生：开始按钮只是调用注入进来的 runner（默认是
// collector.js 的 runCollect，和命令行跑的是同一条流水线、同一套自动
// 模式挑登录来源）。测试时可以注入假 runner，不碰浏览器、不碰 IG。
// 服务器在点「开始采集」之前绝不启动任何浏览器。

const http = require('http');
const config = require('../config');
const storeMod = require('./store');
const leadsOut = require('./leadsOut');
const xlsx = require('./xlsx');

const MAX_KEYWORDS = 10;

// 与 collector.cleanKeyword 同一条规则（本模块不反向 require collector，
// 避免循环依赖）：去掉开头的 # 和所有空白。
function cleanKeyword(raw) {
  return String(raw || '').replace(/^#+/, '').replace(/\s+/g, '').trim();
}

// 把页面/接口给的关键词输入收拾成话题列表：数组逐条清洗，或整段文本
// 按行切；再按英文逗号拆（和命令行的 --keyword a,b 口径一致）；
// 去空、去重、最多 MAX_KEYWORDS 个。
function normalizeKeywords(input) {
  let parts = [];
  if (Array.isArray(input)) parts = input.slice();
  else if (typeof input === 'string') parts = input.split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    for (const piece of String(p || '').split(',')) {
      const kw = cleanKeyword(piece);
      if (!kw || seen.has(kw)) continue;
      seen.add(kw);
      out.push(kw);
      if (out.length >= MAX_KEYWORDS) return out;
    }
  }
  return out;
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IG采集控制台</title>
<style>
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; margin: 24px auto; max-width: 880px; padding: 0 16px; color: #222; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 16px; }
  label { display: block; font-size: 14px; margin: 12px 0 6px; }
  textarea { width: 100%; box-sizing: border-box; font-size: 14px; padding: 8px; }
  input[type=number] { width: 90px; font-size: 14px; padding: 6px; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 14px 0; }
  button, a.btn { font-size: 14px; padding: 8px 18px; border: 1px solid #bbb; background: #f5f5f5; border-radius: 6px; cursor: pointer; color: #222; text-decoration: none; }
  button.primary { background: #0095f6; border-color: #0095f6; color: #fff; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  .cards { display: flex; gap: 12px; margin: 16px 0; }
  .card { flex: 1; border: 1px solid #ddd; border-radius: 8px; padding: 12px; text-align: center; }
  .card .num { font-size: 26px; font-weight: bold; }
  .card .cap { color: #666; font-size: 13px; margin-top: 4px; }
  #log { border: 1px solid #ddd; border-radius: 8px; background: #111; color: #ddd; font-family: Consolas, monospace; font-size: 12.5px; line-height: 1.55; height: 340px; overflow-y: auto; padding: 10px 12px; white-space: pre-wrap; word-break: break-all; }
  .status { font-size: 13px; color: #666; }
</style>
</head>
<body>
<h1>IG 采集控制台</h1>
<div class="sub">博主模式（默认）：先按关键词找粉丝多的卖货博主，再采他们帖子下面的意向评论。登录用脚本的自动模式（cookies 文件夹 / accounts.txt），和命令行完全一致。主号黑名单、限速、停止条件都照旧写死。</div>

<label for="keywords">关键词（每行一个，最多 10 个）</label>
<textarea id="keywords" rows="5">downjacket</textarea>

<div class="row">
  <label for="posts" style="margin:0">每词帖子数（直采模式用）</label>
  <input id="posts" type="number" value="50" min="1" max="50">
  <button id="btnStart" class="primary">开始采集</button>
  <button id="btnStop" disabled>停止</button>
  <span class="status" id="status">空闲</span>
</div>

<div class="row">
  <label for="minFollowers" style="margin:0">博主最低粉丝</label>
  <input id="minFollowers" type="number" value="10000" min="0" step="1000">
  <label for="bloggers" style="margin:0">每词博主数</label>
  <input id="bloggers" type="number" value="5" min="1" max="20">
  <span class="status">博主模式：每个博主最多采 10 条帖子；筛不到博主时自动回退话题直采</span>
</div>

<div class="cards">
  <div class="card"><div class="num" id="statPosts">–</div><div class="cap">累计帖子</div></div>
  <div class="card"><div class="num" id="statLeads">–</div><div class="cap">累计评论线索</div></div>
  <div class="card"><div class="num" id="statUsers">–</div><div class="cap">去重用户</div></div>
</div>

<div class="row">
  <a class="btn" href="/api/export.xlsx">导出Excel（累计名单）</a>
  <a class="btn" href="/api/export.csv">导出CSV（累计名单）</a>
</div>

<label>运行日志</label>
<div id="log"></div>

<script>
var since = 0;
var logBox = document.getElementById('log');
function appendLines(lines) {
  if (!lines.length) return;
  var nearBottom = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 30;
  for (var i = 0; i < lines.length; i++) {
    var div = document.createElement('div');
    div.textContent = lines[i];
    logBox.appendChild(div);
  }
  if (nearBottom) logBox.scrollTop = logBox.scrollHeight;
}
function pollLog() {
  fetch('/api/log?since=' + since).then(function (r) { return r.json(); }).then(function (d) {
    appendLines(d.lines || []);
    since = d.total;
  }).catch(function () {}).then(function () { setTimeout(pollLog, 1000); });
}
function pollState() {
  fetch('/api/stats').then(function (r) { return r.json(); }).then(function (d) {
    document.getElementById('statPosts').textContent = d.posts;
    document.getElementById('statLeads').textContent = d.leads;
    document.getElementById('statUsers').textContent = d.users;
  }).catch(function () {});
  fetch('/api/state').then(function (r) { return r.json(); }).then(function (d) {
    document.getElementById('btnStart').disabled = !!d.running;
    document.getElementById('btnStop').disabled = !d.running;
    document.getElementById('status').textContent = d.running ? '正在采集…' : '空闲';
  }).catch(function () {}).then(function () { setTimeout(pollState, 3000); });
}
document.getElementById('btnStart').addEventListener('click', function () {
  var words = document.getElementById('keywords').value.split(/\\r?\\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  var posts = parseInt(document.getElementById('posts').value, 10) || 50;
  var minFollowers = parseInt(document.getElementById('minFollowers').value, 10);
  if (isNaN(minFollowers) || minFollowers < 0) minFollowers = 10000;
  var bloggers = parseInt(document.getElementById('bloggers').value, 10);
  if (isNaN(bloggers) || bloggers < 1) bloggers = 5;
  if (!words.length) { alert('先填至少一个关键词'); return; }
  fetch('/api/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keywords: words, posts: posts, minFollowers: minFollowers, bloggers: bloggers })
  }).then(function (r) {
    return r.json().then(function (d) { return { status: r.status, body: d }; });
  }).then(function (res) {
    if (res.status === 409) alert('已有一轮采集在运行，先等它跑完或点停止。');
    else if (!res.body.ok) alert('启动失败：' + (res.body.error || res.status));
    pollState();
  }).catch(function (e) { alert('启动失败：' + e); });
});
document.getElementById('btnStop').addEventListener('click', function () {
  fetch('/api/stop', { method: 'POST' }).then(function () { pollState(); });
});
pollLog();
pollState();
</script>
</body>
</html>`;

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { req.destroy(); resolve({}); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

// 建一个控制台服务。opts：
// - port：监听端口（默认 config.guiPort；传 0 = 随机端口，测试用）
// - storeFile：累积存储文件（默认 config.storeFile；测试可指临时文件）
// - runner：async (runOpts, control) => void，runOpts 含
//   { keywords, posts, minFollowers, bloggers, log }，
//   control = { stopFlag: { stopped } }。
//   不给 runner 时「开始采集」会明确报错，不会假装在跑。
// 只绑 127.0.0.1（写死回环，不接受外部绑定参数）。
function createGuiServer(opts) {
  const o = opts || {};
  const port = o.port !== undefined ? o.port : config.guiPort;
  const storeFile = o.storeFile || config.storeFile;
  const runner = typeof o.runner === 'function' ? o.runner : null;

  const logLines = [];
  let logBase = 0;
  let running = false;
  let control = null;

  function pushLog(text) {
    logLines.push(String(text));
    if (logLines.length > 20000) {
      const drop = logLines.length - 20000;
      logLines.splice(0, drop);
      logBase += drop;
    }
  }

  function currentStore() {
    return storeMod.loadStore(storeFile).store;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const p = u.pathname;

      if (req.method === 'GET' && p === '/') {
        const body = Buffer.from(PAGE_HTML, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
        res.end(body);
        return;
      }
      if (req.method === 'GET' && p === '/api/log') {
        const sinceRaw = parseInt(u.searchParams.get('since') || '0', 10);
        const since = Number.isFinite(sinceRaw) && sinceRaw > logBase ? sinceRaw : logBase;
        sendJson(res, 200, { lines: logLines.slice(since - logBase), total: logBase + logLines.length });
        return;
      }
      if (req.method === 'GET' && p === '/api/state') {
        sendJson(res, 200, { running: running });
        return;
      }
      if (req.method === 'GET' && p === '/api/stats') {
        sendJson(res, 200, storeMod.statsOf(currentStore()));
        return;
      }
      if (req.method === 'GET' && p === '/api/export.csv') {
        const body = Buffer.from(leadsOut.toCsv(storeMod.leadsRows(currentStore())), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="leads-all.csv"',
          'Content-Length': body.length,
        });
        res.end(body);
        return;
      }
      if (req.method === 'GET' && p === '/api/export.xlsx') {
        const body = xlsx.buildLeadsXlsx(storeMod.leadsRows(currentStore()));
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="leads-all.xlsx"',
          'Content-Length': body.length,
        });
        res.end(body);
        return;
      }
      if (req.method === 'POST' && p === '/api/start') {
        if (running) {
          sendJson(res, 409, { ok: false, error: '已有一轮采集在运行' });
          return;
        }
        if (!runner) {
          sendJson(res, 500, { ok: false, error: '这个服务没有配置采集执行器' });
          return;
        }
        const body = await readJsonBody(req);
        const keywords = normalizeKeywords(body.keywords);
        if (keywords.length === 0) {
          sendJson(res, 400, { ok: false, error: '至少填一个关键词' });
          return;
        }
        let posts = parseInt(body.posts, 10);
        if (!Number.isFinite(posts) || posts < 1) posts = config.limits.postsDefault;
        posts = Math.min(posts, config.limits.postsMax);
        let minFollowers = parseInt(body.minFollowers, 10);
        if (!Number.isFinite(minFollowers) || minFollowers < 0) minFollowers = config.blogger.minFollowersDefault;
        minFollowers = Math.min(minFollowers, config.blogger.minFollowersMax);
        let bloggers = parseInt(body.bloggers, 10);
        if (!Number.isFinite(bloggers) || bloggers < 1) bloggers = config.blogger.bloggersDefault;
        bloggers = Math.min(bloggers, config.blogger.bloggersMax);
        running = true;
        control = { stopFlag: { stopped: false } };
        const thisControl = control;
        pushLog('———— 控制台启动一轮采集：关键词 ' + keywords.map((k) => '#' + k).join('、') + '，博主模式（最低粉丝 ' + minFollowers + '，每词博主数 ' + bloggers + '），直采每词最多 ' + posts + ' 帖 ————');
        // 不 await：请求先返回，采集在后台跑，日志走 /api/log 轮询。
        Promise.resolve()
          .then(() => runner({ keywords: keywords, posts: posts, minFollowers: minFollowers, bloggers: bloggers, log: pushLog }, thisControl))
          .then(() => pushLog('———— 本轮采集结束 ————'))
          .catch((e) => pushLog('采集出错：' + (e && e.message ? e.message : e)))
          .then(() => { running = false; if (control === thisControl) control = null; });
        sendJson(res, 200, { ok: true, keywords: keywords, posts: posts, minFollowers: minFollowers, bloggers: bloggers });
        return;
      }
      if (req.method === 'POST' && p === '/api/stop') {
        if (control && control.stopFlag) control.stopFlag.stopped = true;
        pushLog('已收到停止请求：当前帖子处理完就停（已采数据照常保存）。');
        sendJson(res, 200, { ok: true, running: running });
        return;
      }
      sendJson(res, 404, { ok: false, error: '没有这个接口' });
    } catch (e) {
      try { sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) }); } catch (_) { /* 忽略 */ }
    }
  });

  server.listen(port, '127.0.0.1');
  return {
    server: server,
    pushLog: pushLog,
    isRunning: () => running,
    getControl: () => control,
    close: () => new Promise((resolve) => { try { server.close(() => resolve()); } catch (_) { resolve(); } }),
  };
}

module.exports = { createGuiServer, normalizeKeywords, cleanKeyword, PAGE_HTML };
