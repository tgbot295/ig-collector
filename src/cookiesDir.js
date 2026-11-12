'use strict';
// cookies/ 文件夹自动扫描（纯本地，可单测）：用户把卖家给的 cookie 文件
// 直接丢进 cookies/ 文件夹，文件名随便（可无扩展名），脚本自己找、自己读。
//
// 安全红线（写死）：
// - 本模块的任何返回值、日志都不包含文件内容和 cookie 的值（value），
//   对外只报告文件名和原因类别（读不出 / 没有sessionid）。
// - cookies/ 里的文件等于账号钥匙，只留在本机（.gitignore 已整夹排除，
//   只保留说明文件 README-放这里.md 进仓库）。
const fs = require('fs');
const path = require('path');
const sessionStore = require('./session');

// 文件夹里随仓库分发的说明文件，不当作 cookie 候选
const PLACEHOLDER_NAME = 'README-放这里.md';

// 把解析错误归成一句话类别（对外只报类别，绝不带原文/值）：
// 错误信息里点名 sessionid 的归“没有sessionid”，其余归“读不出”。
function reasonCategory(err) {
  const msg = err && err.message ? String(err.message) : '';
  if (msg.includes('sessionid')) return '没有sessionid';
  return '读不出';
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

// 逐个候选读文本并用 session.js 的解析（纯 JSON / 带标题行 / Base64 包装都认）：
// - 能解出带 sessionid 的 storageState 的进 parseable（保持文件名排序）；
// - 解不出的进 unparseable，只留 { file, reason }，reason 只是一句类别。
// 返回 { parseable: [{ file, fullPath, storageState }], unparseable: [{ file, reason }] }
function loadCandidates(dir) {
  const parseable = [];
  const unparseable = [];
  for (const cand of scanCookiesDir(dir)) {
    let text;
    try {
      text = fs.readFileSync(cand.fullPath, 'utf8');
    } catch (_) {
      unparseable.push({ file: cand.file, reason: '读不出' });
      continue;
    }
    try {
      const storageState = sessionStore.parseSessionText(text);
      parseable.push({ file: cand.file, fullPath: cand.fullPath, storageState: storageState });
    } catch (e) {
      unparseable.push({ file: cand.file, reason: reasonCategory(e) });
    }
  }
  return { parseable: parseable, unparseable: unparseable };
}

module.exports = {
  PLACEHOLDER_NAME,
  reasonCategory,
  scanCookiesDir,
  loadCandidates,
};
