'use strict';
// cookies/ 文件夹自动扫描（纯本地，可单测）：用户把卖家给的 cookie 文件
// 直接丢进 cookies/ 文件夹，文件名随便（可无扩展名），脚本自己找、自己读。
//
// 安全红线（写死）：
// - 本模块的任何返回值、日志都不包含文件内容和 cookie 的值（value），
//   对外只报告文件名、格式和原因类别。
// - cookies/ 里的文件等于账号钥匙，只留在本机（.gitignore 已整夹排除，
//   只保留说明文件 README-放这里.md 进仓库）。
const fs = require('fs');
const path = require('path');
const sessionStore = require('./session');

// 文件夹里随仓库分发的说明文件，不当作 cookie 候选
const PLACEHOLDER_NAME = 'README-放这里.md';

// 格式代码 → 中文短名（给“像X格式但没有sessionid”这类原因拼句子用）
const FORMAT_REASON_NAMES = {
  'netscape': 'Netscape',
  'cookie-header': 'Cookie头',
  'json-dict': 'JSON字典',
  'base64': 'Base64包装',
};

// 把解析错误归成一句话类别（对外只报类别，绝不带原文/值）：
// - 空文件                        → '空文件'
// - 认出了格式但缺 sessionid      → '像Netscape格式但没有sessionid' 之类；
//   JSON 家族沿用旧口径            → '没有sessionid'
// - 其余读不出的                  → '读不出（格式不认）'
function reasonCategory(err) {
  if (err && err.code === 'empty') return '空文件';
  if (err && err.code === 'missing_sessionid') {
    const name = err.formatDetected && FORMAT_REASON_NAMES[err.formatDetected];
    if (name) return '像' + name + '格式但没有sessionid';
    return '没有sessionid';
  }
  if (err && err.code) return '读不出（格式不认）';
  // 兜底（旧错误没有 code 时按文案猜）：点名 sessionid 的归没有，其余归读不出
  const msg = err && err.message ? String(err.message) : '';
  if (msg.includes('sessionid')) return '没有sessionid';
  return '读不出（格式不认）';
}

// 扫描目录，返回候选文件（按文件名排序）：
// [{ file: 文件名, fullPath: 完整路径 }]
// 只收普通文件；跳过点文件、跳过说明文件、跳过子目录；任何扩展名（含无扩展名）都收。
// 目录不存在/读不了时返回空数组（自动模式会继续走后面的回退顺序）。
function scanCookiesDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => name !== PLACEHOLDER_NAME)
    .sort()
    .map((name) => ({ file: name, fullPath: path.join(dir, name) }));
}

// 逐个候选读字节并用 session.js 的解析（编码层 + JSON/Base64/Netscape/Cookie头都认）：
// - 能解出带 sessionid 的 storageState 的进 parseable（保持文件名排序）；
//   卖家整行格式还会带出 detectedUsername（只有用户名，供开浏览器前的
//   黑名单预检），密码/邮箱永远不出现在返回值里；
// - 解不出的进 unparseable，只留 { file, reason }，reason 只是一句类别。
// 返回 { parseable: [{ file, fullPath, storageState, detectedUsername }],
//         unparseable: [{ file, reason }] }
function loadCandidates(dir) {
  const parseable = [];
  const unparseable = [];
  for (const cand of scanCookiesDir(dir)) {
    let buf;
    try {
      buf = fs.readFileSync(cand.fullPath); // 读字节：编码（UTF-16 等）交给 session.js 判断
    } catch (_) {
      unparseable.push({ file: cand.file, reason: '读不出（格式不认）' });
      continue;
    }
    const a = sessionStore.analyzeSessionBuffer(buf);
    if (a.storageState) {
      parseable.push({
        file: cand.file,
        fullPath: cand.fullPath,
        storageState: a.storageState,
        detectedUsername: a.detectedUsername || null,
      });
    } else {
      unparseable.push({ file: cand.file, reason: reasonCategory(a.error) });
    }
  }
  return { parseable: parseable, unparseable: unparseable };
}

// 体检单个文件（--check-cookies 用）：只返回可以安全打印的东西——
// 文件名、格式中文名、cookie 名字清单、是否有 sessionid、结论和原因类别，
// 以及卖家整行认出的账号名 detectedUsername（只有用户名，用户在自己机器
// 上看自己的文件没问题）。绝不返回任何 cookie 的值、密码或邮箱。
// 文件读不到时按不可用处理，不抛错。
function diagnoseFile(fullPath, label) {
  let buf;
  try {
    buf = fs.readFileSync(fullPath);
  } catch (_) {
    return {
      file: label || path.basename(fullPath),
      format: '未知',
      cookieNames: [],
      hasSessionid: false,
      detectedUsername: null,
      ok: false,
      reason: '读不出（格式不认）',
    };
  }
  const a = sessionStore.analyzeSessionBuffer(buf);
  return {
    file: label || path.basename(fullPath),
    format: sessionStore.FORMAT_LABELS[a.format] || '未知',
    cookieNames: a.cookieNames || [],
    hasSessionid: !!a.hasSessionid,
    // 卖家整行里认出的账号名（只有用户名；密码/邮箱不在 analyze 结果里）
    detectedUsername: a.detectedUsername || null,
    ok: !!a.storageState,
    reason: a.storageState ? '' : reasonCategory(a.error),
  };
}

module.exports = {
  PLACEHOLDER_NAME,
  reasonCategory,
  scanCookiesDir,
  loadCandidates,
  diagnoseFile,
};
