'use strict';
// 浏览器启动策略（纯逻辑，可单测）：优先用电脑上现成的浏览器，
// 最后才退到 Playwright 自带 Chromium。
//
// 背景：Playwright 的浏览器内核要从 cdn.playwright.dev 下载，在部分
// 地区会被墙（403 AccessDenied，"not available in your location"），
// 所以不再依赖下载，改用本机已装的 Google Chrome / Microsoft Edge。
//
// 本模块不直接 require playwright：真正的启动动作由调用方以
// launchFn(candidate) 注入，方便单测用假函数验证顺序与回退。

// 候选顺序写死：Chrome → Edge → 自带 Chromium。
// channel 为 null 表示不传 channel（用 Playwright 自带内核）。
const CANDIDATES = [
  { key: 'chrome', channel: 'chrome', label: '本机 Google Chrome', short: 'Google Chrome' },
  { key: 'msedge', channel: 'msedge', label: '本机 Microsoft Edge', short: 'Microsoft Edge' },
  { key: 'chromium', channel: null, label: 'Playwright 自带 Chromium', short: 'Playwright Chromium' },
];

const VALID_KEYS = CANDIDATES.map((c) => c.key);

function isValidChoice(v) {
  return VALID_KEYS.indexOf(String(v || '').trim().toLowerCase()) !== -1;
}

// forced 给了合法值（chrome/msedge/chromium）就只返回那一个候选；
// 没给就返回全部三个（按上面的顺序）；给了非法值返回空数组。
function buildCandidates(forced) {
  if (!forced) return CANDIDATES.slice();
  const f = String(forced).trim().toLowerCase();
  const hit = CANDIDATES.find((c) => c.key === f);
  return hit ? [hit] : [];
}

// 给一组 launch 选项按候选加上 channel（自带 Chromium 不加）。
function withChannel(options, candidate) {
  const opts = Object.assign({}, options || {});
  if (candidate && candidate.channel) opts.channel = candidate.channel;
  else delete opts.channel;
  return opts;
}

function firstLine(e) {
  const msg = e && e.message ? String(e.message) : String(e || '');
  return msg.split('\n')[0].slice(0, 200);
}

// 依次尝试候选：launchFn(candidate) 成功即返回 { result, candidate }。
// 某个候选失败只记一行简短原因并继续下一个，不外抛、不打印堆栈。
// 全部失败时抛一个聚合错误：message 只含候选名字（不含底层错误原文），
// 简短原因放在 err.failures 里供调用方按需展示。
async function tryLaunch(launchFn, forced) {
  const candidates = buildCandidates(forced);
  if (candidates.length === 0) {
    throw new Error('--browser 只能是 chrome / msedge / chromium，你给的是：' + String(forced));
  }
  const failures = [];
  for (const cand of candidates) {
    try {
      const result = await launchFn(cand);
      return { result: result, candidate: cand };
    } catch (e) {
      failures.push(cand.key + '：' + firstLine(e));
    }
  }
  const names = candidates.map((c) => c.key + '（' + c.label + '）').join('、');
  const err = new Error('浏览器全部启动失败，已依次试过：' + names);
  err.failures = failures;
  err.candidates = candidates;
  throw err;
}

module.exports = { CANDIDATES, VALID_KEYS, isValidChoice, buildCandidates, withChannel, tryLaunch };
