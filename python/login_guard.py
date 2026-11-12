# -*- coding: utf-8 -*-
"""守卫模块（纯函数，不 import playwright，可单测）。移植自 JS 版 src/guard.js。

1) 主号黑名单 —— 登录账号命中黑名单必须立即中止采集（写死，不可绕过）。
2) 停止页检测 —— 验证/检查点、登录墙、限流提示页出现时停跑，不硬闯。
3) 登录核验分类器 —— 基于一组“信号”给登录结论，不凭单一信号下判断。

注意：classify_login_signals 的 verdict 集合与 JS 版完全一致：
logged_in | checkpoint | retry | session_expired | not_confirmed
（login_wall 是 detect_stop_page 的 reason，不是核验 verdict；
两轮核验流程靠 retry / session_expired 区分“再看一次”和“判失效”。）
"""
import re

# Mmox 的主号/旧号，绝不能用来采集（写死）
DEFAULT_BLOCKLIST = ['nataliem.jordan', 'mm8989221', 'lvlong2026']


def normalize_username(u):
    return re.sub(r'^@+', '', str(u or '').strip()).lower()


def is_blocked_username(username, blocklist=None):
    target = normalize_username(username)
    if not target:
        return False
    lst = blocklist if (isinstance(blocklist, list) and blocklist) else DEFAULT_BLOCKLIST
    return any(normalize_username(b) == target for b in lst)


CHECKPOINT_URL_RE = re.compile(r'/(challenge|checkpoint|auth_platform)(/|\?|#|$)', re.I)
LOGIN_URL_RE = re.compile(r'/accounts/login(/|\?|#|$)', re.I)

CHECKPOINT_PHRASES = [
    "help us confirm it's you",
    "confirm it's you",
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
]

RATE_LIMIT_PHRASES = [
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
]

LOGIN_PHRASES = [
    'log in to instagram',
    'sign up to see photos',
    '登录 instagram',
    '登录或注册',
    '登录后查看',
]

REASON_LABELS = {
    'checkpoint': '遇到验证/检查点页面（需要人工验证）',
    'login_wall': '被登录墙拦截（未登录或登录态失效）',
    'rate_limit': '遇到限流提示（平台要求稍后再试）',
    'blocked_main_account': '登录的是黑名单主号，已按保护规则中止',
    'not_logged_in': '未能确认登录态（未登录）',
    'session_expired': '导入的会话文件已失效（账号已退出登录、改过密码或被平台过期）',
    'login_failed': '自动登录失败（用户名或密码不正确，或登录未完成）',
    'account_mismatch': '浏览器里登录的是另一个账号，与所选账号不一致',
    'network_error': '网络打开页面失败',
    'browser_launch_failed': '浏览器启动失败',
    'playwright_missing': '未安装 Playwright 或浏览器内核',
    'user_stop': '用户手动停止（控制台/终端要求停）',
}


def reason_label(reason):
    return REASON_LABELS.get(reason) or reason or ''


def detect_stop_page(info=None):
    """输入 {'url', 'text'}，命中停止条件返回 {'reason', 'detail'}，否则 None。"""
    info = info or {}
    u = str(info.get('url') or '')
    t = str(info.get('text') or '')
    tl = t.lower()

    if CHECKPOINT_URL_RE.search(u):
        return {'reason': 'checkpoint', 'detail': 'URL 命中验证/检查点路径'}
    for p in CHECKPOINT_PHRASES:
        if p.lower() in tl or p in t:
            return {'reason': 'checkpoint', 'detail': '页面出现验证提示：' + p}
    if LOGIN_URL_RE.search(u):
        return {'reason': 'login_wall', 'detail': '被重定向到登录页'}
    for p in RATE_LIMIT_PHRASES:
        if p.lower() in tl or p in t:
            return {'reason': 'rate_limit', 'detail': '页面出现限流提示：' + p}
    for p in LOGIN_PHRASES:
        if p.lower() in tl or p in t:
            return {'reason': 'login_wall', 'detail': '页面要求登录：' + p}
    return None


# ---------------------------------------------------------------------------
# 登录核验分类器（纯函数，可单测）：打开 IG 首页、关掉插屏并等页面安定后，
# 先采集一组“信号”（只含布尔与 URL/标题，绝不含任何 cookie 值），再由
# 这里给结论。
#
# 教训（实地证据）：曾经只凭“没提取到用户名”就判 session_expired，但页面
# 其实已经登录上了——用户名提取不可靠，绝不能作为已登录的必要条件。
# 现在的准绳是三条同时成立即算已登录（用户名只是加分项）：
#   (a) 浏览器上下文里还留着 instagram.com 的 sessionid cookie
#   (b) 当前 URL 不是登录 URL
#   (c) 页面上没有【可见的】密码输入框
#
# signals = {
#   url, title,
#   urlIsLogin,              # URL 落在 /accounts/login
#   hasVisiblePasswordInput, # 页面里有可见的密码输入框
#   hasLoginForm,            # 页面里有登录表单（弱信号，DOM 里藏着也算）
#   hasProfileNavSignal,     # 已登录导航信号（个人主页链接/设置齿轮/头像）
#   hasCheckpointSignal,     # URL 或文案命中验证/检查点
#   hasSessionidCookie,      # 上下文里还有 sessionid cookie
#   hasUsername,             # 读到了当前用户名（尽力而为，读不到不算失败）
# }
# pass_num = 第几次核验（1 起）。session_expired 判得非常严：只有在插屏
# 处理过、又刷新重看一次之后，登录 URL 或可见密码框依然存在，才准判
# 失效；其余不明确的情况给 retry（第一次）或 not_confirmed（第二次），
# 由调用方存调试截图人工看，绝不冒充“已失效”。
# 返回 {'verdict', 'detail'}，verdict ∈
#   logged_in | checkpoint | retry | session_expired | not_confirmed
#
# 特别注意：onetap“保存登录信息？”页不是登录墙——它出现在已登录之后，
# collect 信号时应先关掉插屏（见 browser_bits.dismiss_interstitials），
# 分类器这边也不把任何 onetap 信号当登录墙处理。
# ---------------------------------------------------------------------------
def classify_login_signals(signals, pass_num=1):
    s = signals or {}
    p = 2 if (isinstance(pass_num, (int, float)) and pass_num >= 2) else 1
    url = str(s.get('url') or '')
    url_is_login = bool(s.get('urlIsLogin')) or bool(LOGIN_URL_RE.search(url))

    if s.get('hasCheckpointSignal') or CHECKPOINT_URL_RE.search(url):
        return {'verdict': 'checkpoint', 'detail': '命中验证/检查点信号'}
    if s.get('hasUsername') or s.get('hasProfileNavSignal'):
        return {'verdict': 'logged_in', 'detail': '有已登录信号（用户名/导航）'}
    # 准绳三条：有 sessionid、没被赶到登录 URL、没有可见密码框
    if s.get('hasSessionidCookie') and not url_is_login and not s.get('hasVisiblePasswordInput'):
        return {'verdict': 'logged_in', 'detail': '上下文有 sessionid、不在登录页、无可见密码框'}
    strict_wall = url_is_login or bool(s.get('hasVisiblePasswordInput'))
    soft_wall = strict_wall or bool(s.get('hasLoginForm'))
    if soft_wall:
        if p < 2:
            return {'verdict': 'retry', 'detail': '第一次核验像登录墙，等刷新后再看一次'}
        if strict_wall:
            return {'verdict': 'session_expired', 'detail': '刷新后登录 URL/可见密码框依然在，会话未被服务器接受'}
        return {'verdict': 'not_confirmed', 'detail': '只有隐藏的登录表单信号，无法确认失效'}
    if p < 2:
        return {'verdict': 'retry', 'detail': '第一次核验信号不明确，等刷新后再看一次'}
    return {'verdict': 'not_confirmed', 'detail': '两次核验都无法确认登录态（既不是登录墙，也没有已登录信号）'}
