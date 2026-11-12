'use strict';
// 守卫模块（纯函数，可单测）：
// 1) 主号黑名单 —— 登录账号命中黑名单必须立即中止采集（写死，不可绕过）。
// 2) 停止页检测 —— 验证/检查点、登录墙、限流提示页出现时停跑，不硬闯。

// Mmox 的主号/旧号，绝不能用来采集（FEATURES.md 第 8 节写死）
const DEFAULT_BLOCKLIST = ['nataliem.jordan', 'mm8989221', 'lvlong2026'];

function normalizeUsername(u) {
  return String(u || '').trim().replace(/^@+/, '').toLowerCase();
}

function isBlockedUsername(username, blocklist) {
  const target = normalizeUsername(username);
  if (!target) return false;
  const list = Array.isArray(blocklist) && blocklist.length ? blocklist : DEFAULT_BLOCKLIST;
  return list.some((b) => normalizeUsername(b) === target);
}

const CHECKPOINT_URL_RE = /\/(challenge|checkpoint)(\/|\?|#|$)/i;
const LOGIN_URL_RE = /\/accounts\/login(\/|\?|#|$)/i;

const CHECKPOINT_PHRASES = [
  'help us confirm it\'s you',
  'confirm it\'s you',
  'suspicious activity',
  'unusual activity',
  'verify your identity',
  'suspicious login attempt',
  '确认是你本人',
  '验证你的身份',
  '我们检测到异常',
  '检测到异常活动',
  '安全验证',
  '输入验证码',
];

const RATE_LIMIT_PHRASES = [
  'please wait a few minutes',
  'try again later',
  'action blocked',
  'temporarily blocked',
  'rate limit',
  '请稍等',
  '稍后再试',
  '操作太频繁',
  '操作过于频繁',
  '请求过于频繁',
  '已暂时被限制',
  '暂时限制',
];

const LOGIN_PHRASES = [
  'log in to instagram',
  'sign up to see photos',
  '登录 instagram',
  '登录或注册',
  '登录后查看',
];

const REASON_LABELS = {
  checkpoint: '遇到验证/检查点页面（需要人工验证）',
  login_wall: '被登录墙拦截（未登录或登录态失效）',
  rate_limit: '遇到限流提示（平台要求稍后再试）',
  blocked_main_account: '登录的是黑名单主号，已按保护规则中止',
  not_logged_in: '未能确认登录态（未登录）',
  session_expired: '导入的会话文件已失效（账号已退出登录、改过密码或被平台过期）',
  login_failed: '自动登录失败（用户名或密码不正确，或登录未完成）',
  account_mismatch: '浏览器里登录的是另一个账号，与所选账号不一致',
  network_error: '网络打开页面失败',
  browser_launch_failed: '浏览器启动失败',
  playwright_missing: '未安装 Playwright 或浏览器内核',
};

function reasonLabel(reason) {
  return REASON_LABELS[reason] || reason || '';
}

// 输入 {url, text}，命中停止条件返回 {reason, detail}，否则返回 null
function detectStopPage(input) {
  const { url = '', text = '' } = input || {};
  const u = String(url || '');
  const t = String(text || '');
  const tl = t.toLowerCase();

  if (CHECKPOINT_URL_RE.test(u)) {
    return { reason: 'checkpoint', detail: 'URL 命中验证/检查点路径' };
  }
  for (const p of CHECKPOINT_PHRASES) {
    if (tl.includes(p.toLowerCase()) || t.includes(p)) {
      return { reason: 'checkpoint', detail: '页面出现验证提示：' + p };
    }
  }
  if (LOGIN_URL_RE.test(u)) {
    return { reason: 'login_wall', detail: '被重定向到登录页' };
  }
  for (const p of RATE_LIMIT_PHRASES) {
    if (tl.includes(p.toLowerCase()) || t.includes(p)) {
      return { reason: 'rate_limit', detail: '页面出现限流提示：' + p };
    }
  }
  for (const p of LOGIN_PHRASES) {
    if (tl.includes(p.toLowerCase()) || t.includes(p)) {
      return { reason: 'login_wall', detail: '页面要求登录：' + p };
    }
  }
  return null;
}

module.exports = {
  DEFAULT_BLOCKLIST,
  normalizeUsername,
  isBlockedUsername,
  detectStopPage,
  reasonLabel,
};
