'use strict';
// 本地 IG 采集引擎（原型）：在脚本自己的浏览器里登录，
// 按关键词/话题搜帖、打开帖子、读公开评论，结果写成本地 JSON（app 导入兼容形状）。
//
// 红线（写死）：
// - 不收密码：首次在可见浏览器窗口里由用户手动登录，登录态只存本地 browser-profile/
// - 登录账号命中主号黑名单（config.blocklist）立即中止
// - 动作间隔随机 3–6 秒；遇到验证/登录墙/限流页立即停，保存已采数据，不重试硬闯
// - 缺字段给 null，绝不编造

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const config = require('./config');
const guard = require('./src/guard');
const extract = require('./src/extract');
const accounts = require('./src/accounts');
const { generateTotp } = require('./src/totp');
const sessionStore = require('./src/session');
const cookiesDir = require('./src/cookiesDir');
const browserLaunch = require('./src/browserLaunch');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const humanPause = () => sleep(randInt(config.delays.minMs, config.delays.maxMs));
const smallPause = () => sleep(randInt(1200, 2500));

function printUsage() {
console.log([
'本地 IG 采集引擎（原型）— 用法：',
'',
' node collector.js --keyword <关键词> [--posts N] [--comments N]',
'',
'参数：',
' --keyword 必填。话题关键词，如 downjacket（可带空格/#，会自动处理成话题名）',
' --posts 本次最多采多少条帖子，默认 20，硬上限 50',
' --comments 每条帖子最多读多少条评论，默认 50',
' --headless 无头模式（仅调试/自测用；首次登录必须用有窗口模式手动登录）',
' --account <用户名> 用 accounts.txt 里这个账号自动登录（一次只跑一个账号）',
' --manual 强制手动登录模式（忽略 accounts.txt）',
' --import-session <文件> 用会话文件直登（本工具导出的 .storage.json，类似 TG 的 .session）',
' --import-cookies <文件> 用 cookie 文件直登（JSON 数组/对象、Netscape cookies.txt、',
'    Cookie 头都认，关键看 sessionid；UTF-16 等记事本编码也能读）',
' --cookies-dir <目录> 自动模式扫描的 cookie 文件夹，默认 ./cookies',
' --check-cookies 只体检 cookie 文件（不登录、不采集）：扫描 cookies 文件夹',
'    （可用 --cookies-dir 换目录）和根目录 cookies.txt / cookies.json，逐个文件',
'    只报文件名、认出的格式、cookie 名字（绝不报值）、有没有 sessionid 和结论，',
'    然后退出。文件被跳过又不知道为什么时，先跑这个看。',
' --browser <chrome|msedge|chromium> 强制只用某个浏览器；不给时依次试本机',
'    Google Chrome、Microsoft Edge、Playwright 自带 Chromium。也可用环境',
'    变量 IG_COLLECTOR_BROWSER 指定（--browser 优先）。推荐用本机 Chrome：',
'    自带 Chromium 的下载源在部分地区被墙（403），装不上。',
' --help 显示本说明',
'',
'自动模式（默认）：只给 --keyword、不给任何登录参数时，脚本按顺序自动找',
'登录来源：cookies/ 文件夹里的卖家 cookie 文件（文件名随便，按文件名顺序',
'在登录核验阶段逐个试，失效的换下一个，命中主号黑名单立即中止）→',
'根目录 cookies.txt / cookies.json → accounts.txt（只有一个账号时自动用）。',
'都没有就显示本说明退出，不会自己乱登。显式参数永远优先于自动模式。',
'',
'两种登录方式（显式指定时）：',
' A) 账号文件自动登录：把账号写进本目录的 accounts.txt（一行一个：',
'    用户名----密码----邮箱----TOTP密钥，后两列可省略），运行时加',
'    --account <用户名> 就会自动填账密登录；有 TOTP 双重验证时自动生成动态码，',
'    短信/邮件验证码则会让你在终端里手动输入。accounts.txt 只放本地，不要外传。',
' B) 手动登录（默认回退）：首次运行打开浏览器窗口，你在窗口里手动登录',
'    专用小号（不要用主号，登录到主号会被黑名单保护立即中止），登录后回',
'    终端按回车继续。',
'登录态保存在本地 browser-profile/ 目录（账号模式按用户名分开存），之后复用。',
'采集结果写入 out/ 目录的 JSON 文件，可直接导入本地版 IG 工具。',
].join('\n'));
}

function cleanKeyword(raw) {
return String(raw || '').replace(/^#+/, '').replace(/\s+/g, '').trim();
}

function parseArgs(argv) {
const args = { keyword: '', posts: config.limits.postsDefault, comments: config.limits.commentsDefault, headless: false, help: false, account: '', manual: false, importSession: '', importCookies: '', cookiesDir: config.cookiesDir, browser: '', checkCookies: false };
for (let i = 0; i < argv.length; i++) {
const a = argv[i];
if (a === '--help' || a === '-h') args.help = true;
else if (a === '--check-cookies') args.checkCookies = true;
else if (a === '--headless') args.headless = true;
else if (a === '--manual') args.manual = true;
else if (a === '--import-session') args.importSession = String(argv[++i] || '').trim();
else if (a.startsWith('--import-session=')) args.importSession = a.slice('--import-session='.length).trim();
else if (a === '--import-cookies') args.importCookies = String(argv[++i] || '').trim();
else if (a.startsWith('--import-cookies=')) args.importCookies = a.slice('--import-cookies='.length).trim();
else if (a === '--cookies-dir') args.cookiesDir = String(argv[++i] || '').trim() || config.cookiesDir;
else if (a.startsWith('--cookies-dir=')) args.cookiesDir = a.slice('--cookies-dir='.length).trim() || config.cookiesDir;
else if (a === '--browser') args.browser = String(argv[++i] || '').trim().toLowerCase();
else if (a.startsWith('--browser=')) args.browser = a.slice('--browser='.length).trim().toLowerCase();
else if (a === '--account') args.account = String(argv[++i] || '').trim();
else if (a.startsWith('--account=')) args.account = a.slice('--account='.length).trim();
else if (a === '--keyword') args.keyword = cleanKeyword(argv[++i] || '');
else if (a === '--posts') args.posts = parseInt(argv[++i], 10);
else if (a === '--comments') args.comments = parseInt(argv[++i], 10);
else if (a.startsWith('--keyword=')) args.keyword = cleanKeyword(a.slice('--keyword='.length));
else if (a.startsWith('--posts=')) args.posts = parseInt(a.slice('--posts='.length), 10);
else if (a.startsWith('--comments=')) args.comments = parseInt(a.slice('--comments='.length), 10);
}
if (!args.browser) args.browser = String(process.env.IG_COLLECTOR_BROWSER || '').trim().toLowerCase();
if (!Number.isFinite(args.posts) || args.posts < 1) args.posts = config.limits.postsDefault;
args.posts = Math.min(args.posts, config.limits.postsMax);
if (!Number.isFinite(args.comments) || args.comments < 1) args.comments = config.limits.commentsDefault;
args.comments = Math.min(args.comments, config.limits.commentsMax);
return args;
}

function waitForEnter(promptText) {
return new Promise((resolve) => {
const rl = readline.createInterface({ input: process.stdin, output: process.stdout});
let done = false;
const finish = () => { if (!done) { done = true; try { rl.close();} catch (_) {} resolve();}};
rl.question(promptText, finish);
rl.on('close', finish);
});
}

// 从终端读一行（用于短信/邮件验证码）：读到的内容只当场填入页面，
// 不打印、不记录、不落盘。
function readLineFromStdin(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { rl.close(); } catch (_) {} resolve(v || ''); } };
    rl.question(promptText, (ans) => finish(String(ans || '').trim()));
    rl.on('close', () => finish(''));
  });
}

// 处理双重验证：有 TOTP 密钥就本地生成动态码填入；没有就请用户在终端输入
// 短信/邮件验证码（工具不读短信邮箱）。返回 'none' | 'done' | 'failed' | 'checkpoint'
// 安全：验证码和 TOTP 密钥绝不打印、不落盘。
async function handleTwoFactor(page, account, state) {
  if (state.twoFactorDone) return 'none';
  let codeCount = 0;
  try {
    codeCount = await page.locator('input[name="security_code"], input[autocomplete="one-time-code"], input[name="verificationCode"]').count();
  } catch (_) { /* 忽略 */ }
  let bodyHit = false;
  if (!codeCount) {
    try {
      const t = await page.evaluate(() => ((document.body && document.body.innerText) || '').slice(0, 2000));
      bodyHit = /two-factor|双重验证|安全码|输入验证码|enter the code|输入代码/i.test(t);
    } catch (_) { /* 忽略 */ }
  }
  if (!codeCount && !bodyHit) return 'none';

  let code = '';
  if (account.totpSecret) {
    try {
      code = generateTotp(account.totpSecret);
      console.log('检测到双重验证，正在用本地 TOTP 密钥生成动态码并填入（码不显示、不记录）…');
    } catch (e) {
      console.log('accounts.txt 里这个账号的 TOTP 密钥格式不对，生成不了动态码。');
      return 'failed';
    }
  } else {
    console.log('IG 要求短信/邮件验证码，这类码工具读不到你的短信和邮箱，需要你手动输入。');
    code = await readLineFromStdin('请把收到的验证码输入到这里后回车（只用于本次登录，不保存）：');
    if (!code) return 'failed';
  }

  try {
    if (codeCount) {
      await page.locator('input[name="security_code"], input[autocomplete="one-time-code"], input[name="verificationCode"]').first().fill(code);
    } else {
      await page.locator('input[type="text"], input[type="tel"]').first().fill(code);
    }
    await smallPause();
    await page.locator('button[type="submit"], button:has-text("Confirm"), button:has-text("确认"), button:has-text("Submit"), button:has-text("提交")').first().click({ timeout: 8000 });
  } catch (e) {
    return 'failed';
  }
  state.twoFactorDone = true;
  await sleep(1500);
  return 'done';
}

// 用 accounts.txt 的账号自动登录：填用户名+密码提交，再处理双重验证。
// 返回 { ok:true, username } 或 { ok:false, reason }。
// 安全：密码只从本地文件读入并填进页面，绝不出现在任何日志/输出里。
async function autoLogin(page, account) {
  console.log('正在用账号 @' + account.username + ' 自动登录（密码从本地 accounts.txt 读取，不显示、不记录）…');
  try {
    await page.goto(config.baseUrl + '/accounts/login/', { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
  } catch (e) {
    return { ok: false, reason: 'network_error' };
  }
  await smallPause();
  let stop = await checkStop(page);
  if (stop && stop.reason !== 'login_wall') return { ok: false, reason: stop.reason };

  try {
    await page.locator('input[name="username"]').fill(account.username, { timeout: 10000 });
    await page.locator('input[name="password"]').fill(account.password, { timeout: 10000 });
    await smallPause();
    await page.locator('button[type="submit"]').first().click({ timeout: 10000 });
  } catch (e) {
    return { ok: false, reason: 'login_failed' };
  }

  const state = { twoFactorDone: false };
  for (let i = 0; i < 25; i++) {
    await sleep(1200);
    stop = await checkStop(page);
    if (stop && (stop.reason === 'checkpoint' || stop.reason === 'rate_limit')) {
      return { ok: false, reason: stop.reason };
    }
    // “保存登录信息？”提示一律点以后再说，避免卡住
    try {
      const nb = page.getByText(/Not now|以后再说|暂不/i).first();
      if (await nb.count()) await nb.click({ timeout: 1500 });
    } catch (_) { /* 忽略 */ }

    const handled = await handleTwoFactor(page, account, state);
    if (handled === 'failed') return { ok: false, reason: 'login_failed' };

    const uname = await detectLoggedInUsername(page);
    if (uname) return { ok: true, username: uname };

    if (i > 3) {
      try {
        const t = await page.evaluate(() => ((document.body && document.body.innerText) || '').slice(0, 1500));
        if (/incorrect|密码错误|用户名或密码不正确|wrong password/i.test(t)) {
          return { ok: false, reason: 'login_failed' };
        }
      } catch (_) { /* 忽略 */ }
    }
  }
  return { ok: false, reason: 'login_failed' };
}

// 登录确认成功后，把当前会话导出成单个 .storage.json（等同 TG 的 .session）：
// 之后在任何机器/目录用 --import-session <文件> 即可直登，不用密码、不用 2FA。
// 安全：只打印文件路径和用户名，绝不打印任何 cookie 值；文件权限 0600。
async function exportSessionState(context, username) {
try {
const state = await context.storageState();
const file = sessionStore.sessionFilePath(config.sessionsDir, username);
sessionStore.writeStorageStateFile(file, state);
console.log('登录会话已导出：' + file + '（账号 @' + username + '）');
console.log('提醒：这个会话文件等于账号钥匙，只放本地，不要上传、不要分享、不要发聊天。');
return file;
} catch (e) {
console.log('会话导出失败（不影响本次采集）：' + (e && e.message? e.message.split('\n')[0]: e));
return null;
}
}

function saveOutput(output) {
fs.mkdirSync(config.outDir, { recursive: true});
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const file = path.join(config.outDir, 'collect-' + output.keyword + '-' + ts + '.json');
fs.writeFileSync(file, JSON.stringify(output, null, 2), 'utf8');
return file;
}

// 尽力识别当前登录的用户名：先走页面自己的 current_user 接口，再退回头像 alt 文本
async function detectLoggedInUsername(page) {
try {
const viaApi = await page.evaluate(async () => {
try {
const r = await fetch('/api/v1/accounts/current_user/?edit=true', {
headers: { 'X-IG-App-ID': '936619743392459'},
credentials: 'include',
});
if (!r.ok) return null;
const j = await r.json();
return (j && j.user && j.user.username) || null;
} catch (e) { return null;}
});
if (viaApi) return viaApi;
} catch (_) { /* 忽略，走 DOM 兜底 */}
try {
const viaDom = await page.evaluate(() => {
const imgs = Array.from(document.querySelectorAll('img[alt]'));
for (const img of imgs) {
const m = (img.getAttribute('alt') || '').match(/^([A-Za-z0-9._]+)'s profile picture/);
if (m) return m[1];
}
return null;
});
if (viaDom) return viaDom;
} catch (_) { /* 忽略 */}
return null;
}

async function checkStop(page) {
let text = '';
try {
text = await page.evaluate(() => ((document.body && document.body.innerText) || '').slice(0, 4000));
} catch (_) { /* 页面跳转中等情况 */}
return guard.detectStopPage({ url: page.url(), text});
}

// 从帖子页提取数据：页面内嵌 JSON 优先，og 元信息补计数；评论再从 DOM 展开读取
async function extractPostData(page, link) {
let result = null;
try {
const html = await page.content();
result = extract.extractPostFromText(html, link.url);
} catch (_) { /* 忽略 */}

let og = { ogDesc: null, ogImage: null};
try {
og = await page.evaluate(() => {
const get = (sel) => {
const el = document.querySelector(sel);
return el? el.getAttribute('content'): null;
};
return {
ogDesc: get('meta[property="og:description"]'),
ogImage: get('meta[property="og:image"]'),
};
});
} catch (_) { /* 忽略 */}

const post = (result && result.post) || {
id: null, shortCode: link.shortCode, type: '', caption: '', hashtags: [],
mentions: [], url: link.url, likesCount: null, commentsCount: null,
timestamp: null, displayUrl: '', videoUrl: '', ownerUsername: '', ownerFullName: '',
};
const counts = extract.parseOgCounts(og.ogDesc);
if (post.likesCount === null || post.likesCount === undefined) post.likesCount = counts.likesCount;
if (post.commentsCount === null || post.commentsCount === undefined) post.commentsCount = counts.commentsCount;
if (!post.displayUrl && og.ogImage) post.displayUrl = og.ogImage;
if (!post.url) post.url = link.url;
if (!post.shortCode) post.shortCode = link.shortCode;
return { post: post, payloadComments: (result && result.comments) || []};
}

// 在帖子页展开评论区并从 DOM 读评论（尽力而为，读不到就返回已有的）
async function collectDomComments(page, postUrl, limit, existing) {
const byKey = new Map();
const add = (c) => {
if (!c || (!c.text &&!c.ownerUsername)) return;
const key = (c.ownerUsername || '') + '|' + (c.text || '');
if (!byKey.has(key)) byKey.set(key, c);
};
(existing || []).forEach(add);

// 尝试点开“查看全部评论”
for (let i = 0; i < 3; i++) {
try {
const btn = page.getByText(/view all|view more|查看全部|查看更多|展开评论/i).first();
await btn.click({ timeout: 2500});
await smallPause();
} catch (_) { break;}
}

let stagnant = 0;
for (let round = 0; round < 12 && byKey.size < limit; round++) {
let rows = [];
try {
rows = await page.evaluate(() => {
const root = document.querySelector('div[role="dialog"]') || document.querySelector('article') || document.body;
const out = [];
root.querySelectorAll('ul li').forEach((li) => {
const a = li.querySelector('a[href^="/"]');
if (!a) return;
const username = (a.textContent || '').trim();
if (!username || /\s/.test(username)) return;
let text = '';
li.querySelectorAll('span').forEach((s) => {
const t = (s.textContent || '').trim();
if (t && t!== username && t.length > text.length &&!/^(like|reply|点赞|回复|查看翻译)/i.test(t)) text = t;
});
const time = li.querySelector('time');
const ts = time? (time.getAttribute('datetime') || null): null;
if (text) out.push({ ownerUsername: username, text: text, timestamp: ts});
});
return out;
});
} catch (_) { /* 忽略 */}

const before = byKey.size;
for (const r of rows) {
add(extract.normalizeComment({ text: r.text, ownerUsername: r.ownerUsername, timestamp: extract.toIso(r.timestamp) || r.timestamp, postUrl: postUrl}));
}
if (byKey.size >= limit) break;
if (byKey.size === before) { stagnant++; if (stagnant >= 2) break;} else stagnant = 0;

// 滚动评论区（找可滚动容器滚到底）+ 整页滚动兜底
try {
await page.evaluate(() => {
const root = document.querySelector('div[role="dialog"]') || document.querySelector('article') || document.body;
root.querySelectorAll('div, ul').forEach((el) => {
if (el.scrollHeight > el.clientHeight + 40) el.scrollTop = el.scrollHeight;
});
window.scrollBy(0, 800);
});
} catch (_) { /* 忽略 */}
await smallPause();
}
return Array.from(byKey.values()).slice(0, limit);
}

// --check-cookies 体检：逐个文件只报文件名、格式、cookie 名字（绝不报值）、
// 有没有 sessionid 和结论。用户把输出贴回来就能定位“文件为什么被跳过”，
// 不需要把文件本身发给任何人。
function runCheckCookies(args) {
const targets = [];
for (const cand of cookiesDir.scanCookiesDir(args.cookiesDir)) {
targets.push({ fullPath: cand.fullPath, label: cand.file });
}
for (const rootName of ['cookies.txt', 'cookies.json']) {
const rootPath = path.join(__dirname, rootName);
if (fs.existsSync(rootPath)) targets.push({ fullPath: rootPath, label: rootName + '（根目录）' });
}
console.log('cookie 文件体检（只报文件名、格式和 cookie 名字，绝不报任何值）：');
if (targets.length === 0) {
console.log('（一个文件都没找到：cookies 文件夹是空的，根目录也没有 cookies.txt / cookies.json）');
console.log('先把卖家给的 cookie 文件放进 cookies 文件夹（文件名随便），再跑一次。');
return 0;
}
for (const t of targets) {
const d = cookiesDir.diagnoseFile(t.fullPath, t.label);
const names = d.cookieNames.length > 0 ? d.cookieNames.join('、') : '（无）';
// 卖家整行里认出的账号名可以显示（用户在自己机器上看自己的文件）；
// 密码/邮箱从不出现在体检结果里。
const accountPart = d.detectedUsername ? '；账号：' + d.detectedUsername : '';
if (d.ok) {
console.log('[可用] ' + d.file + ' — 格式：' + d.format + '；cookie：' + names + '；sessionid：有' + accountPart);
} else {
console.log('[不可用] ' + d.file + ' — 格式：' + d.format + '；cookie：' + names +
'；sessionid：' + (d.hasSessionid ? '有' : '无') + accountPart + '；原因：' + d.reason);
}
}
return 0;
}

async function run(argv) {
const args = parseArgs(argv);
if (args.checkCookies) {
return runCheckCookies(args);
}
if (args.help ||!args.keyword) {
printUsage();
return 0;
}
if (args.browser && !browserLaunch.isValidChoice(args.browser)) {
console.log('错误：--browser 只能是 chrome / msedge / chromium（或用环境变量 IG_COLLECTOR_BROWSER），你给的是：' + args.browser);
return 1;
}

// ---- 启动检查：out/ 里若混进 accounts.txt，警告并忽略（只认 collector 根目录的）----
if (fs.existsSync(path.join(config.outDir, 'accounts.txt'))) {
  console.log('警告：out/ 目录里发现 accounts.txt，已忽略它。账号文件只应放在 collector 根目录，不要放进 out/，更不要外传。');
}

// ---- 会话文件直登（--import-session / --import-cookies）：开浏览器前先把文件读好 ----
// 会话文件等于账号钥匙：这里只读进内存，控制台只报 cookie 名字/数量，绝不报值。
let importMode = null; // 'import-session' | 'import-cookies' | null
let importState = null;
let importDetectedUsername = null; // 卖家整行里认出的账号名（只有用户名）
if (args.importSession && args.importCookies) {
console.log('错误：--import-session 和 --import-cookies 只能选一个。');
return 1;
}
const importFile = args.importSession || args.importCookies;
if (importFile) {
importMode = args.importSession ? 'import-session' : 'import-cookies';
try {
const detailed = sessionStore.loadSessionFileDetailed(importFile);
importState = detailed.storageState;
importDetectedUsername = detailed.detectedUsername;
} catch (e) {
console.log('错误：' + e.message);
return 1;
}
const sum = sessionStore.summarizeState(importState);
console.log('已读取会话文件（' + importMode + '）：共 ' + sum.cookieCount + ' 个 cookie，包含 ' +
sum.cookieNames.join('、') + '。文件等于账号钥匙，只放本地。');
// 卖家整行附带的账号名先过黑名单预检：命中主号在开浏览器之前就中止
// （退出码 2）；没命中也只是预检，登录后还会核验实际登录的账号。
if (importDetectedUsername) {
console.log('文件里附带的账号名：@' + importDetectedUsername + '（仅作预检，登录后还会再核验实际账号）');
if (guard.isBlockedUsername(importDetectedUsername, config.blocklist)) {
console.log('错误：文件里附带的账号 @' + importDetectedUsername + ' 是受保护的主号，拒绝用它登录采集（还没打开浏览器就已中止）。');
return 2;
}
}
}

// ---- 账号选择（开浏览器之前完成；一次只跑一个账号，不轮换；会话导入模式跳过）----
let selected = null;
// 自动模式（只给 --keyword、没指定任何登录方式）时挑出的候选会话：
// [{ label, storageState, detectedUsername }]，label 只含来源和文件名
// （不含任何 cookie 值）；detectedUsername 只有用户名本身（可为 null）。
// 在登录核验阶段按顺序逐个试（见下面浏览器阶段），开始采集后不再换号。
let autoCandidates = null;
if (!importMode && !args.manual) {
  if (args.account) {
    if (!fs.existsSync(config.accountsFile)) {
      console.log('错误：你指定了 --account，但 collector 目录里没有 accounts.txt。请先按 README 的格式建好这个文件。');
      return 1;
    }
    const parsedFile = accounts.loadAccounts(config.accountsFile);
    parsedFile.warnings.forEach((w) => console.log('accounts.txt 第 ' + w.line + ' 行提醒：' + w.message));
    const sel = accounts.selectAccount(parsedFile.accounts, args.account);
    if (sel.error === 'blocked') {
      console.log('错误：@' + args.account + ' 是受保护的主号，拒绝用它登录采集。请换专用小号。');
      return 2;
    }
    if (sel.error === 'not_found') {
      console.log('错误：accounts.txt 里没有 @' + args.account + ' 这个账号。文件里现有用户名：' +
        accounts.listUsernames(parsedFile.accounts).map((u) => '@' + u).join('、'));
      return 1;
    }
    selected = sel.account;
  } else {
    // ===== 自动模式（只给了 --keyword）：按顺序自己找登录来源 =====
    // 1) cookies/ 文件夹里的卖家 cookie 文件（文件名随便，按文件名排序）
    const dirScan = cookiesDir.loadCandidates(args.cookiesDir);
    dirScan.unparseable.forEach((u) =>
      console.log('cookies 文件夹里的文件「' + u.file + '」跳过（' + u.reason + '），不会使用它。'));
    if (dirScan.parseable.length > 0) {
      autoCandidates = dirScan.parseable.map((c) => ({
        label: 'cookies/' + c.file,
        storageState: c.storageState,
        detectedUsername: c.detectedUsername || null,
      }));
      console.log('自动模式：在 cookies 文件夹里找到 ' + autoCandidates.length +
        ' 个可用的会话文件，将在登录核验阶段按文件名顺序逐个试。');
    } else {
      // 2) 根目录 cookies.txt / cookies.json（旧一键启动的放法，继续认）
      for (const rootName of ['cookies.txt', 'cookies.json']) {
        const rootPath = path.join(__dirname, rootName);
        if (!fs.existsSync(rootPath)) continue;
        try {
          const detailed = sessionStore.loadSessionFileDetailed(rootPath);
          autoCandidates = [{
            label: rootName,
            storageState: detailed.storageState,
            detectedUsername: detailed.detectedUsername,
          }];
          console.log('自动模式：使用根目录的 ' + rootName + ' 里的会话登录。');
          break;
        } catch (e) {
          console.log('根目录的 ' + rootName + ' 跳过（' + cookiesDir.reasonCategory(e) + '），不会使用它。');
        }
      }
    }
    // 3) accounts.txt：只有一个账号时自动用；多个账号不自己挑
    if (!autoCandidates && fs.existsSync(config.accountsFile)) {
      const parsedFile = accounts.loadAccounts(config.accountsFile);
      parsedFile.warnings.forEach((w) => console.log('accounts.txt 第 ' + w.line + ' 行提醒：' + w.message));
      if (parsedFile.accounts.length === 1) {
        if (parsedFile.accounts[0].blocked) {
          console.log('错误：accounts.txt 里唯一的账号 @' + parsedFile.accounts[0].username + ' 是受保护的主号，拒绝用它登录采集。');
          return 2;
        }
        selected = parsedFile.accounts[0];
        console.log('accounts.txt 里只有一个账号，本次使用 @' + selected.username + '（可用 --manual 改走手动登录）。');
      } else if (parsedFile.accounts.length > 1) {
        console.log('accounts.txt 里有多个账号，本次要用哪一个请明确指定（一次只跑一个）：');
        accounts.listUsernames(parsedFile.accounts).forEach((u) => console.log('  @' + u));
        console.log('重新运行并加上：--account <上面的用户名之一>');
        return 1;
      }
    }
    if (!autoCandidates && !selected) {
      console.log('自动模式没找到任何可用的登录来源：cookies 文件夹里没有能读的会话文件，');
      console.log('根目录也没有 cookies.txt / cookies.json，accounts.txt 里也没有可自动使用的账号。');
      console.log('先把卖家给的 cookie 文件放进 cookies 文件夹（文件名随便），或者建好 accounts.txt，');
      console.log('或者用 --import-session / --import-cookies / --manual 指定登录方式。');
      printUsage();
      return 1;
    }
  }
}
if (args.manual) console.log('手动登录模式（--manual）：忽略 accounts.txt。');
// 自动模式黑名单预检：任一候选会话附带的账号名（卖家整行里的用户名）
// 命中主号黑名单，在开浏览器之前就整轮中止（退出码 2），不试不登。
if (autoCandidates) {
  const bad = autoCandidates.find((c) =>
    c.detectedUsername && guard.isBlockedUsername(c.detectedUsername, config.blocklist));
  if (bad) {
    console.log('错误：会话文件 ' + bad.label + ' 附带的账号 @' + bad.detectedUsername +
      ' 是受保护的主号，拒绝用它登录采集（还没打开浏览器就已中止）。');
    return 2;
  }
}
const profileDir = selected ? config.profileDirFor(selected.username) : config.profileDir;

const output = {
keyword: args.keyword,
collectedAt: new Date().toISOString(),
source: 'local-collector',
items: [],
stats: {
account: null,
loginMode: importMode || (autoCandidates ? 'auto-cookies' : (selected ? 'account-file' : 'manual')),
postsFound: 0,
postsCollected: 0,
commentsCollected: 0,
stopped: null,
stoppedLabel: '',
},
};
const finish = (code) => {
const file = saveOutput(output);
if (output.stats.stopped) {
console.log('运行状态：' + JSON.stringify({ stopped: output.stats.stopped, label: output.stats.stoppedLabel, file: file}));
} else {
console.log('运行状态：' + JSON.stringify({ stopped: null, label: '采集完成', file: file}));
}
console.log('结果已保存：' + file);
return code;
};
const stopWith = (reason) => {
output.stats.stopped = reason;
output.stats.stoppedLabel = guard.reasonLabel(reason);
console.log('已停止：' + output.stats.stoppedLabel + '（已保存目前采到的数据）');
};

let chromium;
try {
chromium = require('playwright').chromium;
} catch (e) {
console.log('未找到 Playwright 库。请先在 collector 目录里运行：npm install（浏览器用本机现成的 Chrome / Edge，不用再单独下载内核）');
stopWith('playwright_missing');
return finish(1);
}

let context = null;
let browser = null;
try {
// 所有启动都走同一个策略：本机 Chrome → 本机 Edge → 自带 Chromium
// （--browser / IG_COLLECTOR_BROWSER 给了就只试那一个）。自带 Chromium 的
// 下载源在部分地区被墙，所以现成浏览器优先；某个候选起不来只跳过试下一个，
// 不打印它的报错堆栈。成功后只报一行实际用的浏览器。
if (importMode || autoCandidates) {
const launched = await browserLaunch.tryLaunch(
(cand) => chromium.launch(browserLaunch.withChannel({ headless: args.headless }, cand)),
args.browser || null);
browser = launched.result;
console.log('浏览器：' + launched.candidate.label);
if (importMode) {
context = await browser.newContext({
storageState: importState,
viewport: { width: 1280, height: 900},
});
}
// autoCandidates 时 context 在登录核验阶段按候选逐个创建（见下面），这里先不建
} else {
const launched = await browserLaunch.tryLaunch(
(cand) => chromium.launchPersistentContext(profileDir, browserLaunch.withChannel({
headless: args.headless,
viewport: { width: 1280, height: 900},
}, cand)),
args.browser || null);
context = launched.result;
console.log('浏览器：' + launched.candidate.label);
}
} catch (e) {
console.log('没找到能用的浏览器：请装 Google Chrome（或确认 Edge 在），装好后重跑。');
stopWith('browser_launch_failed');
return finish(1);
}

try {
let page = null;
let username = null;

if (autoCandidates) {
// ---- 自动模式登录核验：候选会话按顺序逐个试 ----
// 第一个核验通过（能确认登录账号）的候选用它跑完整程；失效的报文件名换下一个；
// 回退只发生在这一阶段，一旦开始采集不再换号。核验出的账号若命中黑名单，
// 在后面统一判定处立即中止整个运行（退出码 2），不会拿它去试下一个候选。
const triedLabels = [];
let autoNetError = false;
for (const cand of autoCandidates) {
if (context) { try { await context.close();} catch (_) { /* 忽略 */} context = null;}
try {
context = await browser.newContext({
storageState: cand.storageState,
viewport: { width: 1280, height: 900},
});
} catch (e) {
triedLabels.push(cand.label);
console.log('会话文件 ' + cand.label + ' 打不开（浏览器上下文创建失败），换下一个候选试。');
continue;
}
page = context.pages()[0] || (await context.newPage());
page.setDefaultTimeout(config.actionTimeoutMs);
try {
await page.goto(config.baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs});
} catch (e) {
console.log('打开 Instagram 失败：' + (e && e.message? e.message.split('\n')[0]: e));
stopWith('network_error');
autoNetError = true;
break;
}
await smallPause();
const uname = await detectLoggedInUsername(page);
if (!uname) {
triedLabels.push(cand.label);
console.log('会话文件 ' + cand.label + ' 已失效（session_expired），换下一个候选试。');
continue;
}
username = uname;
console.log('会话文件 ' + cand.label + ' 核验通过，当前登录账号：@' + username);
break;
}
if (autoNetError) return finish(0);
if (!username) {
console.log('自动模式：候选会话全部失效，已逐个试过：' + triedLabels.join('、'));
console.log('请让卖家重新给一份有效的 cookie 文件放进 cookies 文件夹，或改用 --account / --manual 登录。');
stopWith('session_expired');
return finish(0);
}
} else {
page = context.pages()[0] || (await context.newPage());
page.setDefaultTimeout(config.actionTimeoutMs);

try {
await page.goto(config.baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs});
} catch (e) {
console.log('打开 Instagram 失败：' + (e && e.message? e.message.split('\n')[0]: e));
stopWith('network_error');
return finish(0);
}
await smallPause();

username = await detectLoggedInUsername(page);
}
if (importMode) {
if (!username) {
console.log('导入的会话文件没通过登录核验：账号可能已退出登录、改过密码或被平台过期。');
console.log('本次按 session_expired 停止，不自动改走密码登录；请重新登录小号后导出新的会话文件再导入。');
stopWith('session_expired');
return finish(0);
}
console.log('会话文件核验通过，当前登录账号：@' + username);
}
if (!importMode && username && selected && guard.normalizeUsername(username) !== guard.normalizeUsername(selected.username)) {
console.log('注意：这个账号的浏览器配置里已经登录的是 @' + username + '，不是所选的 @' + selected.username + '，本次不停号混用，先停下。');
console.log('如要换账号，请先在浏览器窗口里退出 @' + username + ' 再重跑，或删掉 browser-profile/' + guard.normalizeUsername(selected.username) + '/ 重新登录。');
stopWith('account_mismatch');
return finish(0);
}
if (!importMode && !username && selected) {
const loginResult = await autoLogin(page, selected);
if (!loginResult.ok) {
stopWith(loginResult.reason);
return finish(0);
}
username = loginResult.username;
}
if (!importMode && !username) {
const stop0 = await checkStop(page);
if (args.headless) {
console.log('当前未登录（无头模式下不能手动登录）。请先用有窗口模式运行一次并手动登录小号。');
stopWith(stop0 && stop0.reason === 'checkpoint'? 'checkpoint': 'login_wall');
return finish(0);
}
console.log('');
console.log('==================================================');
console.log('请在打开的浏览器窗口里手动登录你的专用小号，登录好后回到终端按回车继续');
console.log('注意：不要登录主号——登录到主号会被黑名单保护立即中止。');
console.log('==================================================');
await waitForEnter('登录完成后按回车继续…');
try {
await page.goto(config.baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs});
} catch (_) { /* 忽略，下面统一判定 */}
await smallPause();
username = await detectLoggedInUsername(page);
if (!username) {
const stop1 = await checkStop(page);
if (stop1 && stop1.reason === 'checkpoint') stopWith('checkpoint');
else stopWith('not_logged_in');
console.log('没能确认登录态，本次先停。确认小号已在浏览器窗口里登录成功后再运行一次。');
return finish(0);
}
}

if (selected && guard.normalizeUsername(username) !== guard.normalizeUsername(selected.username)) {
stopWith('account_mismatch');
console.log('实际登录的是 @' + username + '，与所选账号 @' + selected.username + ' 不一致，已停。');
return finish(0);
}

output.stats.account = username;
console.log('当前登录账号：@' + username);

if (guard.isBlockedUsername(username, config.blocklist)) {
console.log('错误：当前登录的是受保护的主号 @' + username + '，绝不能用主号采集，已立即中止。');
console.log('请在浏览器窗口里退出这个账号，改用专用小号登录后再运行。');
stopWith('blocked_main_account');
return finish(2);
}

// 登录确认且黑名单检查已过：导出/刷新会话文件，之后可凭文件直登
await exportSessionState(context, username);

// ---- 话题页搜帖 ----
const tagUrl = config.tagsUrl(args.keyword);
console.log('正在打开话题页：#' + args.keyword);
try {
await page.goto(tagUrl, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs});
} catch (e) {
console.log('打开话题页失败：' + (e && e.message? e.message.split('\n')[0]: e));
stopWith('network_error');
return finish(0);
}
await humanPause();

let stop = await checkStop(page);
if (stop) { stopWith(stop.reason); return finish(0);}

const linkMap = new Map();
for (let round = 0; round < config.limits.scrollRoundsMax && linkMap.size < args.posts; round++) {
let hrefs = [];
try {
hrefs = await page.evaluate(() =>
Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')));
} catch (_) { /* 忽略 */}
for (const l of extract.extractPostLinksFromHrefs(hrefs)) {
if (!linkMap.has(l.shortCode)) linkMap.set(l.shortCode, l);
}
if (linkMap.size >= args.posts) break;
try { await page.mouse.wheel(0, 1600);} catch (_) { /* 忽略 */}
await smallPause();
stop = await checkStop(page);
if (stop) { stopWith(stop.reason); break;}
}

const links = Array.from(linkMap.values()).slice(0, args.posts);
output.stats.postsFound = links.length;
console.log('话题页共找到帖子链接 ' + links.length + ' 条，开始逐条采集…');
if (output.stats.stopped) return finish(0);

// ---- 逐帖采集 ----
for (let i = 0; i < links.length; i++) {
const link = links[i];
try {
await page.goto(link.url, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs});
} catch (e) {
console.log('帖子 ' + (i + 1) + '/' + links.length + ' 打开失败，跳过：' + link.url);
await humanPause();
continue;
}
await humanPause();

stop = await checkStop(page);
if (stop) { stopWith(stop.reason); break;}

const data = await extractPostData(page, link);
const comments = await collectDomComments(page, data.post.url || link.url, args.comments, data.payloadComments);
data.post.latestComments = comments;
output.items.push(data.post);
for (const c of comments) output.items.push(c);
output.stats.postsCollected++;
output.stats.commentsCollected += comments.length;
console.log('已采集帖子 ' + (i + 1) + '/' + links.length + '：@' +
(data.post.ownerUsername || '未知') + '，评论 ' + comments.length + ' 条');
await humanPause();
}

return finish(0);
} finally {
if (context) { try { await context.close();} catch (_) { /* 忽略 */}}
if (browser) { try { await browser.close();} catch (_) { /* 忽略 */}}
}
}

if (require.main === module) {
run(process.argv.slice(2))
.then((code) => process.exit(code || 0))
.catch((e) => {
console.log('运行出错：' + (e && e.message? e.message: e));
process.exit(1);
});
}

module.exports = { parseArgs, cleanKeyword, printUsage, runCheckCookies};
