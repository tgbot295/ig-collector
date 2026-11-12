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

const CHECKPOINT_URL_RE = /\/(challenge|checkpoint|auth_platform)(\/|\?|#|$)/i;
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

// ---------------------------------------------------------------------------
// 登录核验分类器（纯函数，可单测）：collector 在导入/自动模式里打开 IG 首页、
// 关掉插屏并等页面安定后，先采集一组“信号”（只含布尔与 URL/标题，绝不含
// 任何 cookie 值），再由这里给结论。
//
// 教训（实地证据）：曾经只凭“没提取到用户名”就判 session_expired，但页面
// 其实已经登录上了——用户名提取不可靠，绝不能作为已登录的必要条件。
// 现在的准绳是三条同时成立即算已登录（用户名只是加分项）：
//   (a) 浏览器上下文里还留着 instagram.com 的 sessionid cookie
//   (b) 当前 URL 不是登录 URL
//   (c) 页面上没有【可见的】密码输入框
//
// signals = {
//   url, title,
//   urlIsLogin,           // URL 落在 /accounts/login
//   hasVisiblePasswordInput, // 页面里有可见的密码输入框
//   hasLoginForm,         // 页面里有登录表单（弱信号，DOM 里藏着也算）
//   hasProfileNavSignal,  // 已登录导航信号（个人主页链接/设置齿轮/头像）
//   hasCheckpointSignal,  // URL 或文案命中验证/检查点
//   hasSessionidCookie,   // 上下文里还有 sessionid cookie
//   hasUsername,          // 读到了当前用户名（尽力而为，读不到不算失败）
// }
// pass = 第几次核验（1 起）。session_expired 判得非常严：只有在插屏处理过、
// 又刷新重看一次之后，登录 URL 或可见密码框依然存在，才准判失效；
// 其余一切不明确的情况给 retry（第一次）或 not_confirmed（第二次），
// 由调用方存调试截图人工看，绝不冒充“已失效”。
// 返回 { verdict, detail }，verdict ∈
//   logged_in | checkpoint | retry | session_expired | not_confirmed
// ---------------------------------------------------------------------------
function classifyLoginSignals(signals, pass) {
  const s = signals || {};
  const p = Number(pass) >= 2 ? 2 : 1;
  const url = String(s.url || '');
  const urlIsLogin = !!(s.urlIsLogin || LOGIN_URL_RE.test(url));

  if (s.hasCheckpointSignal || CHECKPOINT_URL_RE.test(url)) {
    return { verdict: 'checkpoint', detail: '命中验证/检查点信号' };
  }
  if (s.hasUsername || s.hasProfileNavSignal) {
    return { verdict: 'logged_in', detail: '有已登录信号（用户名/导航）' };
  }
  // 准绳三条：有 sessionid、没被赶到登录 URL、没有可见密码框
  if (s.hasSessionidCookie && !urlIsLogin && !s.hasVisiblePasswordInput) {
    return { verdict: 'logged_in', detail: '上下文有 sessionid、不在登录页、无可见密码框' };
  }
  const strictWall = urlIsLogin || !!s.hasVisiblePasswordInput;
  const softWall = strictWall || !!s.hasLoginForm;
  if (softWall) {
    if (p < 2) return { verdict: 'retry', detail: '第一次核验像登录墙，等刷新后再看一次' };
    if (strictWall) return { verdict: 'session_expired', detail: '刷新后登录 URL/可见密码框依然在，会话未被服务器接受' };
    return { verdict: 'not_confirmed', detail: '只有隐藏的登录表单信号，无法确认失效' };
  }
  if (p < 2) return { verdict: 'retry', detail: '第一次核验信号不明确，等刷新后再看一次' };
  return { verdict: 'not_confirmed', detail: '两次核验都无法确认登录态（既不是登录墙，也没有已登录信号）' };
}

module.exports = {
  DEFAULT_BLOCKLIST,
  normalizeUsername,
  isBlockedUsername,
  detectStopPage,
  classifyLoginSignals,
  reasonLabel,
};
