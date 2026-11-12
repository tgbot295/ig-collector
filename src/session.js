'use strict';
// 会话文件模块（纯函数为主，可单测）：IG 没有官方的 .session 文件，
// 能“拿文件直登”的等价物是这三种，本模块负责它们之间的转换与落盘：
//   1) Playwright storageState 单文件（本工具导出为 sessions/<用户名>.storage.json）
//   2) cookie 的 JSON（浏览器扩展导出的裸数组，或 {cookies:[...]} 形状）
//   3) browser-profile/ 浏览器配置目录（在 collector.js / config.js 那边，不在本模块）
//
// 安全红线（写死）：
// - 会话/cookie 文件等于账号钥匙（等同 TG 的 .session），谁持有谁就能登号。
// - 本模块的任何返回值摘要、错误信息、日志都不包含 cookie 的值（value），
//   只允许出现 cookie 的名字（如 sessionid）。报错也只点名缺哪个 cookie。
// - 导出的 .storage.json 文件权限固定 0600（只有本机当前用户可读）。
const fs = require('fs');
const path = require('path');

// IG 登录关键 cookie：sessionid 是登录态本身，缺了它等于没登录。
const LOGIN_CRITICAL_COOKIES = ['sessionid', 'csrftoken', 'ds_user_id'];
const IG_DOMAIN = '.instagram.com';

function isInstagramDomain(domain) {
  if (domain === undefined || domain === null || domain === '') return true; // 没写域名按 IG 处理（导出文件常省略）
  const d = String(domain).trim().toLowerCase().replace(/^\.+/, '');
  return d === 'instagram.com' || d.endsWith('.instagram.com');
}

// 大小写不敏感；null/缺失/unspecified 等无法对应的值返回 null，表示省略该字段
// （Playwright 接受不带 sameSite 的 cookie），不要硬塞一个默认值。
function mapSameSite(v) {
  if (v === undefined || v === null) return null;
  switch (String(v).trim().toLowerCase()) {
    case 'strict': return 'Strict';
    case 'none':
    case 'no_restriction': return 'None';
    case 'lax': return 'Lax';
    default: return null;
  }
}

function toExpires(cookie) {
  let e = cookie.expires !== undefined ? cookie.expires : cookie.expirationDate;
  if (e === undefined || e === null || e === '') return -1;
  if (typeof e === 'string') {
    const t = Date.parse(e);
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
    e = Number(e);
  }
  const n = Number(e);
  if (!Number.isFinite(n) || n <= 0) return -1;
  return Math.floor(n);
}

// 把一条原始 cookie（浏览器扩展格式或 Playwright 格式都认）补齐成 Playwright 形状。
// 不属于 IG 域名的返回 null（丢弃）。
function normalizeCookie(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  if (!name) return null;
  if (!isInstagramDomain(raw.domain)) return null;
  const value = raw.value === undefined || raw.value === null ? '' : String(raw.value);
  // 只重建 Playwright 接受的字段：hostOnly / session / storeId /
  // firstPartyDomain / partitionKey 等导出格式自带的字段一律丢弃。
  const cookie = {
    name: name,
    value: value,
    domain: IG_DOMAIN,
    path: raw.path ? String(raw.path) : '/',
    expires: toExpires(raw),
    // sessionid 本身是 httpOnly；其余按原值，没有就默认 false
    httpOnly: raw.httpOnly !== undefined ? !!raw.httpOnly : name === 'sessionid',
    secure: raw.secure !== undefined ? !!raw.secure : true,
  };
  const sameSite = mapSameSite(raw.sameSite);
  if (sameSite) cookie.sameSite = sameSite; // 无法对应时省略，不硬塞
  return cookie;
}

// 任意输入（裸 cookie 数组 / {cookies:[...]} / storageState）→ Playwright storageState。
// 强制要求 sessionid 存在；缺失时抛错，错误只写 cookie 名字，绝不带任何值。
function toStorageState(input) {
  let rawCookies = null;
  let rawOrigins = [];
  if (Array.isArray(input)) {
    rawCookies = input;
  } else if (input && typeof input === 'object' && Array.isArray(input.cookies)) {
    rawCookies = input.cookies;
    if (Array.isArray(input.origins)) rawOrigins = input.origins;
  }
  if (!rawCookies) {
    throw new Error('会话文件格式不对：没有找到 cookies 数组。请确认导出的文件是 cookie JSON 或本工具的 .storage.json。');
  }
  const byKey = new Map();
  for (const raw of rawCookies) {
    const c = normalizeCookie(raw);
    if (!c) continue;
    byKey.set(c.name + '|' + c.domain + '|' + c.path, c); // 后出现的覆盖先出现的
  }
  const cookies = Array.from(byKey.values());
  if (!cookies.some((c) => c.name === 'sessionid')) {
    throw new Error('会话文件里缺少关键 cookie：sessionid（没有它等于没有登录态）。请确认导出的是已登录 Instagram 的会话/cookie。');
  }
  const origins = rawOrigins.filter((o) => {
    if (!o || typeof o !== 'object') return false;
    try { return isInstagramDomain(new URL(String(o.origin || '')).hostname); } catch (_) { return false; }
  });
  return { cookies: cookies, origins: origins };
}

// 只读摘要：可以安全打印/写日志 —— 只有 cookie 名字和数量，绝不含值。
function summarizeState(state) {
  const cookies = state && Array.isArray(state.cookies) ? state.cookies : [];
  return {
    cookieCount: cookies.length,
    cookieNames: Array.from(new Set(cookies.map((c) => c.name))).sort(),
    hasSessionid: cookies.some((c) => c.name === 'sessionid'),
    loginCriticalPresent: LOGIN_CRITICAL_COOKIES.filter((n) => cookies.some((c) => c.name === n)),
  };
}

function hasCookie(state, name) {
  return !!(state && Array.isArray(state.cookies) && state.cookies.some((c) => c.name === name));
}

// 纯文本解析（第 1、2 步）：先整段 JSON.parse；失败时做方括号截取——
// 剥掉第一个 '[' 之前（或 '{' 之前）的标题/标签行等杂质再试。
// 成功返回解析结果，失败返回 undefined（JSON.parse 本身不会返回 undefined）。
function tryParseJsonText(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    let sliced = null;
    const arrStart = raw.indexOf('[');
    const arrEnd = raw.lastIndexOf(']');
    if (arrStart >= 0 && arrEnd > arrStart) {
      sliced = raw.slice(arrStart, arrEnd + 1);
    } else {
      const objStart = raw.indexOf('{');
      const objEnd = raw.lastIndexOf('}');
      if (objStart >= 0 && objEnd > objStart) sliced = raw.slice(objStart, objEnd + 1);
    }
    if (sliced !== null) {
      try { return JSON.parse(sliced); } catch (_) { /* 落空，返回 undefined */ }
    }
  }
  return undefined;
}

// 判断一段去掉空白的字符串是否长得像 Base64（标准或 URL 安全变体都认）。
function isBase64Shaped(s) {
  if (!s || s.length < 16) return false;
  const mapped = s.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(mapped)) return false;
  // 去掉填充后长度 mod 4 不能为 1（那种长度不可能是合法 Base64）
  if (mapped.replace(/=+$/, '').length % 4 === 1) return false;
  return true;
}

function decodeBase64(s) {
  const mapped = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(mapped, 'base64').toString('utf8');
}

// 第 3 步（Base64 恢复）的候选串，按成功概率排序，逐个试解码：
//   a) 去掉首行（标签行）后全文去空白 —— 卖家文件常见“标题行 + Base64 正文”
//   b) 全文去空白 —— 无标签行、可能按固定宽度折行或字符组间带空格的 Base64
//   c) 只保留本身像 Base64 的行再拼接 —— 标签行混在中间时兜底
// 解码或解析失败的候选直接跳过，不抛错、不打印任何文件内容。
function base64Candidates(raw) {
  const strip = (s) => String(s).replace(/\s+/g, '');
  const lines = String(raw).split(/\r?\n/);
  const nonEmpty = lines.filter((l) => strip(l).length > 0);
  const cands = [];
  if (nonEmpty.length > 1) cands.push(strip(nonEmpty.slice(1).join('')));
  cands.push(strip(raw));
  const shapedOnly = nonEmpty.filter((l) => isBase64Shaped(strip(l)));
  if (shapedOnly.length > 0 && shapedOnly.length < nonEmpty.length) {
    cands.push(strip(shapedOnly.join('')));
  }
  return Array.from(new Set(cands)).filter(isBase64Shaped);
}

// 从文件内容文本解析会话（--import-session 与 --import-cookies 共用入口）。
// 依次尝试：1) 纯 JSON；2) 带标题行的 JSON（方括号截取）；
// 3) Base64 包装（整份 cookie JSON 被 Base64 编码，可能折行/带空格/URL 安全变体，
//    解码后回到 1–2 步，解码文本里带杂质也能靠方括号截取救回来）。
function parseSessionText(text) {
  const raw = String(text || '');
  let parsed = tryParseJsonText(raw);
  if (parsed === undefined) {
    for (const cand of base64Candidates(raw)) {
      let decoded = '';
      try { decoded = decodeBase64(cand); } catch (_) { continue; }
      if (!decoded) continue;
      parsed = tryParseJsonText(decoded);
      if (parsed !== undefined) break;
    }
  }
  if (parsed === undefined || parsed === null) {
    throw new Error('会话文件不是合法的 JSON，读不了。已试过纯 JSON、带标题行 JSON、Base64 包装三种读法都失败，文件可能是未支持的编码格式，或已损坏。请确认文件没有损坏，或向卖家索取纯 JSON 格式的 cookie 导出。');
  }
  return toStorageState(parsed);
}

function loadSessionFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error('会话文件读不到：' + filePath + '（请确认路径正确）');
  }
  return parseSessionText(text);
}

// sessions/<用户名>.storage.json 的落盘路径（用户名做安全化处理）
function sessionFilePath(sessionsDir, username) {
  const safe = String(username || '').trim().replace(/^@+/, '').toLowerCase()
    .replace(/[^a-z0-9._-]/g, '_');
  return path.join(sessionsDir, (safe || 'unknown') + '.storage.json');
}

// 写 storageState 到文件，权限 0600（已存在的文件也强制改回 0600）。
function writeStorageStateFile(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch (_) { /* Windows 等平台忽略 */}
  return filePath;
}

module.exports = {
  LOGIN_CRITICAL_COOKIES,
  IG_DOMAIN,
  isInstagramDomain,
  normalizeCookie,
  toStorageState,
  summarizeState,
  hasCookie,
  parseSessionText,
  loadSessionFile,
  sessionFilePath,
  writeStorageStateFile,
};
