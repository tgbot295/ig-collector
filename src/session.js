'use strict';
// 会话文件模块（纯函数为主，可单测）：IG 没有官方的 .session 文件，
// 能“拿文件直登”的等价物是这三种，本模块负责它们之间的转换与落盘：
//   1) Playwright storageState 单文件（本工具导出为 sessions/<用户名>.storage.json）
//   2) cookie 的各种导出文本（浏览器扩展 JSON / Netscape cookies.txt / Cookie 头等）
//   3) browser-profile/ 浏览器配置目录（在 collector.js / config.js 那边，不在本模块）
//
// 认得的文本格式（parseSessionText / parseSessionBuffer）：
//   - JSON 裸数组、{cookies:[...]} 对象、storageState
//   - JSON 扁平字典对象 {名字: 值, ...}（含 sessionid 才算可用）
//   - 带首行标签行的上述 JSON（自动剥杂质）
//   - 整份 JSON 被 Base64 包装（可折行/带空格/base64url 变体）
//   - 标签与 Base64 粘在同一行、只以冒号分隔（如 PCBM:<Base64>），以及卖家
//     整行格式 用户名:密码:邮箱:标记:Base64 —— 逐个冒号切分试尾串，能解出
//     cookie 数组的第一个尾串胜出；整行里的用户名只作黑名单预检与体检显示，
//     密码/邮箱字段绝不进任何返回值、日志和报错。
//   - Netscape HTTP Cookie File（经典 cookies.txt，7 段 TAB 分隔，认 #HttpOnly_ 行）
//   - Cookie 头风格 name=value; name2=value2（单行/多行，可带 Cookie: 前缀）
// 文件编码：UTF-8（含 BOM）、UTF-16LE / UTF-16BE（带 BOM，或无 BOM 靠 NUL 分布猜）。
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

// 检测到的格式 → --check-cookies 里显示的名字
const FORMAT_LABELS = {
  'json-array': 'json数组',
  'json-object': 'json对象',
  'json-dict': 'json对象',
  'base64': 'base64包装',
  'netscape': 'netscape',
  'cookie-header': 'cookie头',
  'unknown': '未知',
};

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
  // 会话型 cookie（导出里标了 session:true，如经典的 rur 条目）一律 -1：
  // 它按定义没有到期时间，就算源文件顺带写了一个 expirationDate 也不作数——
  // 写成 0 / 过去的时间戳，浏览器会把这个 cookie 静默丢掉，会话就“被失效”了。
  if (cookie.session === true) return -1;
  let e = cookie.expires !== undefined ? cookie.expires : cookie.expirationDate;
  if (e === undefined || e === null || e === '') return -1; // 没写到期 = 会话 cookie
  if (typeof e === 'string') {
    const t = Date.parse(e);
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
    e = Number(e);
  }
  const n = Number(e);
  // 0 / 负数 / NaN 都不是合法到期时间（Playwright 里 -1 才是“会话 cookie”），
  // 一律归一到 -1，绝不能把 0 或 NaN 透传给浏览器（会被当成已过期丢弃）。
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
  // value 必须逐字节原样透传：不解码、不重新编码、不裁剪。
  // sessionid 本身就是 URL 编码过的（含 %3A 等），任何“顺手处理”
  // 都会让服务器不认这把钥匙，把活会话误判成失效。
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

// 原始 cookie 数组 → storageState（不抛错版）：
// 返回 { cookies, origins, names }；缺 sessionid 时 cookies 仍给出，
// 由调用方决定报错口径。names 是转换前全部 cookie 的名字（已去重），
// 只用于体检报告——名字可以报，值永远不报。
function convertRawCookies(rawCookies, rawOrigins) {
  const names = [];
  const seen = new Set();
  const byKey = new Map();
  for (const raw of rawCookies) {
    if (raw && typeof raw === 'object' && raw.name && !seen.has(String(raw.name))) {
      seen.add(String(raw.name));
      names.push(String(raw.name));
    }
    const c = normalizeCookie(raw);
    if (!c) continue;
    byKey.set(c.name + '|' + c.domain + '|' + c.path, c); // 后出现的覆盖先出现的
  }
  const origins = (Array.isArray(rawOrigins) ? rawOrigins : []).filter((o) => {
    if (!o || typeof o !== 'object') return false;
    try { return isInstagramDomain(new URL(String(o.origin || '')).hostname); } catch (_) { return false; }
  });
  return { cookies: Array.from(byKey.values()), origins: origins, names: names };
}

function missingSessionidError() {
  const err = new Error('会话文件里缺少关键 cookie：sessionid（没有它等于没有登录态）。请确认导出的是已登录 Instagram 的会话/cookie。');
  err.code = 'missing_sessionid';
  return err;
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
    const err = new Error('会话文件格式不对：没有找到 cookies 数组。请确认导出的文件是 cookie JSON 或本工具的 .storage.json。');
    err.code = 'no_cookies_array';
    throw err;
  }
  const conv = convertRawCookies(rawCookies, rawOrigins);
  if (!conv.cookies.some((c) => c.name === 'sessionid')) throw missingSessionidError();
  return { cookies: conv.cookies, origins: conv.origins };
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

// ---------------------------------------------------------------------------
// 文件编码层：Windows 记事本另存的文件可能是 UTF-8 BOM / UTF-16LE / UTF-16BE，
// 直接按 UTF-8 读会读成乱码或带 NUL 的废文本，任何格式都解不出。
// 这里先把字节解成文本：认 BOM；无 BOM 时靠 NUL 字节分布猜 UTF-16
// （纯 UTF-8 文本几乎不含 NUL，所以误判风险低）。
// ---------------------------------------------------------------------------
function decodeBufferText(buf) {
  if (!buf || buf.length === 0) return { text: '', encoding: 'empty' };
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return { text: buf.slice(3).toString('utf8'), encoding: 'utf8-bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return { text: buf.slice(2).toString('utf16le'), encoding: 'utf16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const body = buf.slice(2);
    const swapped = Buffer.allocUnsafe(body.length);
    for (let i = 0; i + 1 < body.length; i += 2) { swapped[i] = body[i + 1]; swapped[i + 1] = body[i]; }
    if (body.length % 2 === 1) swapped[body.length - 1] = body[body.length - 1];
    return { text: swapped.toString('utf16le'), encoding: 'utf16be' };
  }
  if (buf.length >= 4 && buf.length % 2 === 0) {
    let evenZero = 0;
    let oddZero = 0;
    const pairs = buf.length / 2;
    for (let i = 0; i < buf.length; i += 2) {
      if (buf[i] === 0) evenZero++;
      if (buf[i + 1] === 0) oddZero++;
    }
    // UTF-16LE 的 ASCII 字符高字节在奇数位、是 0；UTF-8 文本两边都几乎不会有 0
    if (oddZero / pairs >= 0.25 && evenZero / pairs < 0.05) {
      return { text: buf.toString('utf16le'), encoding: 'utf16le-guess' };
    }
    if (evenZero / pairs >= 0.25 && oddZero / pairs < 0.05) {
      const swapped = Buffer.allocUnsafe(buf.length);
      for (let i = 0; i + 1 < buf.length; i += 2) { swapped[i] = buf[i + 1]; swapped[i + 1] = buf[i]; }
      return { text: swapped.toString('utf16le'), encoding: 'utf16be-guess' };
    }
  }
  return { text: buf.toString('utf8'), encoding: 'utf8' };
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

// 第 3 步（Base64 恢复）的候选串，按成功概率排序，逐个试解码。
// 每个候选是 { text, colonIndex }：colonIndex 是它由哪个冒号切分出来的
// （在原文中的位置），非冒号切分的候选为 null——胜出候选的 colonIndex
// 用来在原文里定位卖家整行的字段（见 detectSellerUsername）。
//   a) 去掉首行（标签行）后全文去空白 —— 卖家文件常见“标题行 + Base64 正文”
//   b) 全文去空白 —— 无标签行、可能按固定宽度折行或字符组间带空格的 Base64
//   c) 只保留本身像 Base64 的行再拼接 —— 标签行混在中间时兜底
//   d) 逐个冒号切分：原文里每一个 ':' 之后的尾巴，去空白后整体像 Base64
//      的都收 —— 覆盖 PCBM:<Base64>（标签粘连）和卖家整行
//      用户名:密码:邮箱:标记:<Base64>（密码字段本身带冒号也行，因为
//      带冒号的中间尾巴过不了形状检查，只有真正的 Base64 尾巴能胜出）
// 解码或解析失败的候选直接跳过，不抛错、不打印任何文件内容。
function base64Candidates(raw) {
  const strip = (s) => String(s).replace(/\s+/g, '');
  const text = String(raw);
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => strip(l).length > 0);
  const cands = [];
  const seen = new Set();
  const push = (t, colonIndex) => {
    if (!isBase64Shaped(t) || seen.has(t)) return;
    seen.add(t);
    cands.push({ text: t, colonIndex: colonIndex });
  };
  if (nonEmpty.length > 1) push(strip(nonEmpty.slice(1).join('')), null);
  push(strip(text), null);
  const shapedOnly = nonEmpty.filter((l) => isBase64Shaped(strip(l)));
  if (shapedOnly.length > 0 && shapedOnly.length < nonEmpty.length) {
    push(strip(shapedOnly.join('')), null);
  }
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ':') continue;
    push(strip(text.slice(i + 1)), i);
  }
  return cands;
}

// 卖家整行元数据：胜出尾串来自冒号切分时，看冒号之前那一行（卖家整行
// 本身就是一行）按 ':' 切开的字段：字段数 ≥3、且有字段含 '@'（邮箱），
// 才认定这是“用户名:密码:邮箱:...”整行，取第 1 个字段作账号名候选。
// 用途只有两个：--check-cookies 显示“账号：<用户名>”，以及开浏览器之前
// 的主号黑名单预检。密码、邮箱字段绝不从这里出去——本函数只返回用户名。
function detectSellerUsername(text, colonIndex) {
  if (colonIndex === null || colonIndex === undefined || colonIndex < 0) return null;
  const head = String(text).slice(0, colonIndex);
  const line = head.split(/\r?\n/).pop() || '';
  const fields = line.split(':');
  if (fields.length < 3) return null;
  if (!fields.some((f) => f.includes('@'))) return null;
  const username = fields[0].trim();
  // 账号名只可能是 IG 用户名字符集；长得不像就当没有，免得误报
  if (!/^[A-Za-z0-9._]+$/.test(username)) return null;
  return username;
}

// ---------------------------------------------------------------------------
// Netscape HTTP Cookie File（经典 cookies.txt）：每行 7 段 TAB 分隔：
//   domain  flag  path  secure  expiration  name  value
// 以 # 开头的是注释行，唯独 "#HttpOnly_" 前缀的行是真 cookie（去掉前缀、
// 标记 httpOnly）。curl / yt-dlp / 各种浏览器扩展导出的就是这种。
// ---------------------------------------------------------------------------
function parseNetscapeLine(line) {
  let httpOnly = false;
  let s = line;
  if (s.startsWith('#HttpOnly_')) { httpOnly = true; s = s.slice('#HttpOnly_'.length); }
  else if (s.startsWith('#')) return null;
  const fields = s.split('\t');
  if (fields.length < 7) return null;
  const name = String(fields[5] || '').trim();
  if (!name || /[\s=;]/.test(name)) return null;
  return {
    domain: String(fields[0] || '').trim(),
    path: String(fields[2] || '').trim() || '/',
    secure: /^true$/i.test(String(fields[3] || '').trim()),
    expires: Number(fields[4]) || -1,
    name: name,
    // value 是最后一段；万一值里混了 TAB，把第 7 段起拼回去
    value: fields.slice(6).join('\t'),
    httpOnly: httpOnly,
  };
}

function tryParseNetscape(text) {
  const lines = String(text).split(/\r?\n/);
  const cookies = [];
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    const c = parseNetscapeLine(line);
    if (c) cookies.push(c);
  }
  return cookies.length > 0 ? cookies : null;
}

// ---------------------------------------------------------------------------
// Cookie 头风格：name=value; name2=value2（单行或多行，每行可带 Cookie: 前缀）。
// 判定从严：文本里不能有 JSON 的 { } [ ]；按行、按 ; 切开后，每段都必须
// 是合法的 name=value；至少 2 对，或者唯一 1 对就是 sessionid，才认定。
// ---------------------------------------------------------------------------
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function tryParseCookieHeader(text) {
  const raw = String(text);
  if (/[{}[\]]/.test(raw)) return null;
  const pairs = [];
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    line = line.replace(/^cookie\s*:\s*/i, '');
    for (const segRaw of line.split(';')) {
      const seg = segRaw.trim();
      if (!seg) continue;
      const eq = seg.indexOf('=');
      if (eq <= 0) return null; // 有一段不是 name=value → 整体不是 Cookie 头
      const name = seg.slice(0, eq).trim();
      if (!COOKIE_NAME_RE.test(name)) return null;
      pairs.push({ name: name, value: seg.slice(eq + 1).trim() });
    }
  }
  if (pairs.length === 0) return null;
  if (pairs.length === 1 && pairs[0].name !== 'sessionid') return null;
  return pairs.map((p) => ({ name: p.name, value: p.value }));
}

// 扁平字典 JSON：{ "sessionid": "...", "csrftoken": "...", ... }
// 顶层每个值都必须是字符串/数字才认定（值里的真假不进判定）。
function tryDictCookies(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (Array.isArray(parsed.cookies)) return null; // 那是 {cookies:[...]} 形状，归 json-object
  const entries = Object.entries(parsed);
  if (entries.length === 0) return null;
  if (!entries.every(([, v]) => typeof v === 'string' || typeof v === 'number')) return null;
  return entries.map(([name, v]) => ({ name: name, value: String(v) }));
}

// 已解析的 JSON → { format, cookies(转换后), names } 或 null（形状不认）。
function convertParsedJson(parsed) {
  if (Array.isArray(parsed)) {
    const conv = convertRawCookies(parsed, []);
    return { format: 'json-array', cookies: conv.cookies, origins: conv.origins, names: conv.names };
  }
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.cookies)) {
      const conv = convertRawCookies(parsed.cookies, parsed.origins);
      return { format: 'json-object', cookies: conv.cookies, origins: conv.origins, names: conv.names };
    }
    const dict = tryDictCookies(parsed);
    if (dict) {
      const conv = convertRawCookies(dict, []);
      return { format: 'json-dict', cookies: conv.cookies, origins: conv.origins, names: conv.names };
    }
  }
  return null;
}

// 把一份“转换结果”收尾成体检结论：有 sessionid 就是可用（给出 storageState），
// 没有就带着格式信息报 missing_sessionid（只点名，不带值）。
function finalizeConversion(conv, format) {
  const hasSid = conv.cookies.some((c) => c.name === 'sessionid');
  if (hasSid) {
    return {
      format: format,
      cookieNames: Array.from(new Set(conv.names)).sort().slice(0, 30),
      hasSessionid: true,
      storageState: { cookies: conv.cookies, origins: conv.origins },
      detectedUsername: null,
      error: null,
    };
  }
  const err = missingSessionidError();
  err.formatDetected = format;
  return {
    format: format,
    cookieNames: Array.from(new Set(conv.names)).sort().slice(0, 30),
    hasSessionid: false,
    storageState: null,
    detectedUsername: null,
    error: err,
  };
}

// 核心分析管线（已解码的文本进）：依次试 JSON（含字典）→ Base64 → Netscape →
// Cookie 头。返回 { format, cookieNames, hasSessionid, storageState,
// detectedUsername, error }（detectedUsername 只在卖家整行胜出时有值），
// 全程不把 cookie 的值放进任何字段（storageState 本身除外——那是内部使用对象）。
function analyzeText(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  if (!raw.trim()) {
    const err = new Error('会话文件是空的，里面什么都没有。请确认放进来的文件没选错。');
    err.code = 'empty';
    return { format: 'unknown', cookieNames: [], hasSessionid: false, storageState: null, detectedUsername: null, error: err };
  }

  // 1) JSON 家族（纯 JSON / 带标签行 / 扁平字典）
  const parsed = tryParseJsonText(raw);
  if (parsed !== undefined && parsed !== null) {
    const conv = convertParsedJson(parsed);
    if (conv) return finalizeConversion(conv, conv.format);
    // JSON 能解开但形状不认：继续往下试别的格式也没有意义，直接报格式不对
    const err = new Error('会话文件格式不对：没有找到 cookies 数组。请确认导出的文件是 cookie JSON 或本工具的 .storage.json。');
    err.code = 'no_cookies_array';
    err.formatDetected = 'json-object';
    return { format: 'json-object', cookieNames: [], hasSessionid: false, storageState: null, detectedUsername: null, error: err };
  }

  // 2) Base64 包装（解开后回到 JSON 家族；外层格式记 base64包装）
  //    第一个能解出 cookie 数组的尾串/候选胜出；若它来自冒号切分，
  //    顺带从卖家整行里认出账号名（只有用户名，密码/邮箱不出本模块）。
  for (const cand of base64Candidates(raw)) {
    let decoded = '';
    try { decoded = decodeBase64(cand.text); } catch (_) { continue; }
    if (!decoded) continue;
    const inner = tryParseJsonText(decoded.replace(/^\uFEFF/, ''));
    if (inner === undefined || inner === null) continue;
    const conv = convertParsedJson(inner);
    if (conv) {
      const result = finalizeConversion(conv, 'base64');
      result.detectedUsername = detectSellerUsername(raw, cand.colonIndex);
      return result;
    }
  }

  // 3) Netscape cookies.txt
  const netscape = tryParseNetscape(raw);
  if (netscape) {
    const conv = convertRawCookies(netscape, []);
    return finalizeConversion(conv, 'netscape');
  }

  // 4) Cookie 头风格
  const header = tryParseCookieHeader(raw);
  if (header) {
    const conv = convertRawCookies(header, []);
    return finalizeConversion(conv, 'cookie-header');
  }

  const err = new Error('会话文件读不了，已试过的读法都失败：纯 JSON、带标题行 JSON、Base64 包装、Netscape cookies.txt、Cookie 头。文件可能是未支持的格式，或已损坏。可以先跑 node collector.js --check-cookies 看每个文件被认成什么格式，或向卖家索取纯 JSON 格式的 cookie 导出。');
  err.code = 'unparseable';
  return { format: 'unknown', cookieNames: [], hasSessionid: false, storageState: null, detectedUsername: null, error: err };
}

// 字节 → 体检结论（先过编码层再进分析管线）
function analyzeSessionBuffer(buf) {
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'utf8');
  const decoded = decodeBufferText(buffer);
  const result = analyzeText(decoded.text);
  result.encoding = decoded.encoding;
  return result;
}

// 从文件内容文本解析会话（--import-session 与 --import-cookies 共用入口）。
function parseSessionText(text) {
  const result = analyzeText(text);
  if (!result.storageState) throw result.error;
  return result.storageState;
}

// 从文件字节解析会话（编码层 + 全部格式）。cookies/ 扫描和 loadSessionFile 走这里，
// 这样 UTF-16 之类记事本编码的文件也能读。
function parseSessionBuffer(buf) {
  const result = analyzeSessionBuffer(buf);
  if (!result.storageState) throw result.error;
  return result.storageState;
}

// 详细版：除了 storageState，还带回体检信息（格式、卖家整行里认出的
// 账号名 detectedUsername）——导入/自动模式靠它在开浏览器之前先过一遍
// 主号黑名单预检。detectedUsername 只有用户名本身，不含密码/邮箱。
function loadSessionFileDetailed(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    throw new Error('会话文件读不到：' + filePath + '（请确认路径正确）');
  }
  const result = analyzeSessionBuffer(buf);
  if (!result.storageState) throw result.error;
  return {
    storageState: result.storageState,
    detectedUsername: result.detectedUsername || null,
    format: result.format,
  };
}

function loadSessionFile(filePath) {
  return loadSessionFileDetailed(filePath).storageState;
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
  FORMAT_LABELS,
  isInstagramDomain,
  normalizeCookie,
  toStorageState,
  summarizeState,
  hasCookie,
  decodeBufferText,
  analyzeText,
  analyzeSessionBuffer,
  parseSessionText,
  parseSessionBuffer,
  detectSellerUsername,
  loadSessionFile,
  loadSessionFileDetailed,
  sessionFilePath,
  writeStorageStateFile,
};
