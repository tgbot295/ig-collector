# -*- coding: utf-8 -*-
"""浏览器侧部件（依赖 playwright，导入时不 import 它、用时才取）。

- launch_browser：启动顺序写死 本机 Google Chrome（channel="chrome"）
  → 本机 Microsoft Edge（channel="msedge"）→ Playwright 自带 chromium，
  并打印实际用的是哪个。绝不要求用户下载自带内核（其下载源在部分
  地区被墙 403）。
- build_context：新建上下文并注入 cookie（卖家文件解析出的
  Playwright 形状 cookie）。
- dismiss_interstitials：关 onetap“保存登录信息？”/通知提示等插屏。
  注意：onetap 页【不是】登录墙，别把它当未登录处理。
- collect_login_signals / verify_login：基于证据的两轮登录核验——
  sessionid cookie 在 + 不在登录 URL + 无可见密码框 = 已登录；
  用户名只作加分项，读不到不判失败（实地教训）。
"""
import json
import os
import random
import time
from datetime import datetime

import extract
import login_guard

BASE_URL = 'https://www.instagram.com'
NAV_TIMEOUT_MS = 45000
ACTION_TIMEOUT_MS = 30000

# 候选顺序写死：Chrome → Edge → 自带 Chromium。
BROWSER_CANDIDATES = [
    {'key': 'chrome', 'channel': 'chrome', 'label': '本机 Google Chrome'},
    {'key': 'msedge', 'channel': 'msedge', 'label': 'Microsoft Edge'},
    {'key': 'chromium', 'channel': None, 'label': 'Playwright 自带 Chromium'},
]
VALID_BROWSER_KEYS = [c['key'] for c in BROWSER_CANDIDATES]


def _sleep(sec):
    time.sleep(sec)


def _small_pause():
    time.sleep(random.uniform(1.2, 2.5))


def is_valid_browser_choice(v):
    return str(v or '').strip().lower() in VALID_BROWSER_KEYS


def build_candidates(forced=None):
    """forced 给了合法值就只返回那一个候选；没给返回全部三个；
    给了非法值返回空列表。"""
    if not forced:
        return list(BROWSER_CANDIDATES)
    f = str(forced).strip().lower()
    for c in BROWSER_CANDIDATES:
        if c['key'] == f:
            return [c]
    return []


def launch_browser(pw, forced=None, headless=False):
    """依次尝试候选浏览器，成功返回 (browser, candidate)。
    某个候选失败只记一行简短原因继续下一个；全部失败抛 RuntimeError
    （message 只含候选名字，不含底层堆栈）。pw 是 playwright 实例
    （sync_playwright() 的返回值），本函数用 pw.chromium.launch。"""
    candidates = build_candidates(forced)
    if not candidates:
        raise RuntimeError('--browser 只能是 chrome / msedge / chromium，你给的是：' + str(forced))
    failures = []
    for cand in candidates:
        try:
            kwargs = {'headless': headless}
            if cand['channel']:
                kwargs['channel'] = cand['channel']
            browser = pw.chromium.launch(**kwargs)
            print('浏览器：' + cand['label'])
            return browser, cand
        except Exception as e:
            msg = str(e).split('\n')[0][:200] if str(e) else ''
            failures.append(cand['key'] + '：' + msg)
    names = '、'.join(c['key'] + '（' + c['label'] + '）' for c in candidates)
    err = RuntimeError('浏览器全部启动失败，已依次试过：' + names)
    err.failures = failures
    raise err


def build_context(browser, cookies=None, viewport=None):
    """新建浏览器上下文并注入 cookie。cookies 是 cookies_parse
    .to_playwright_cookies() 的产物（可为 None/空，表示不注入）。"""
    context = browser.new_context(viewport=viewport or {'width': 1280, 'height': 900})
    if cookies:
        context.add_cookies(cookies)
    return context


def dismiss_interstitials(page):
    """关掉 IG 的插屏/弹窗再做核验，免得把插屏误读成登录状态问题：
    - “保存登录信息？”页（/accounts/onetap/）和同类提示：点 Not now / 以后再说
    - “开启通知？”提示：点 Not Now / 以后再说
    点不到就安静跳过（核验信号里会如实反映页面状态），点到后等页面安定。
    onetap 是已登录之后才出现的页面，它本身【不是】登录墙。"""
    import re as _re
    for _round in range(2):
        clicked = False
        try:
            btn = page.get_by_text(_re.compile(r'^(not now|以后再说|暂不)$', _re.I)).first
            btn.click(timeout=1200)
            clicked = True
        except Exception:
            pass
        if not clicked:
            try:
                btn2 = page.locator(
                    'button:has-text("Not now"), button:has-text("以后再说"), '
                    'div[role="button"]:has-text("Not now"), '
                    'div[role="button"]:has-text("以后再说")').first
                btn2.click(timeout=1200)
                clicked = True
            except Exception:
                pass
        if not clicked:
            break
        _sleep(1.5)


LOGIN_SIGNALS_JS = r"""() => {
  const visible = (el) => {
    if (!el) return false;
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    const st = window.getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden';
  };
  const pwInputs = Array.from(document.querySelectorAll('input[type="password"], input[name="password"]'));
  const hasVisiblePasswordInput = pwInputs.some(visible);
  let hasLoginForm = false;
  document.querySelectorAll('form').forEach((f) => {
    if (f.querySelector('input[name="username"]') || f.querySelector('input[type="password"]') ||
        /login/i.test(f.getAttribute('action') || '')) hasLoginForm = true;
  });
  let hasProfileNavSignal = !!(
    document.querySelector('svg[aria-label="Profile"], svg[aria-label="Settings"], svg[aria-label="Options"]') ||
    document.querySelector('a[href^="/accounts/edit"]')
  );
  if (!hasProfileNavSignal) {
    const imgs = Array.from(document.querySelectorAll('nav img[alt], header img[alt]'));
    hasProfileNavSignal = imgs.some((img) => /'s profile picture/.test(img.getAttribute('alt') || ''));
  }
  return {
    title: document.title || '',
    hasVisiblePasswordInput: hasVisiblePasswordInput,
    hasLoginForm: hasLoginForm,
    hasProfileNavSignal: hasProfileNavSignal,
    bodyText: ((document.body && document.body.innerText) || '').slice(0, 4000),
  };
}"""

CURRENT_USER_JS = r"""async () => {
  try {
    const r = await fetch('/api/v1/accounts/current_user/?edit=true', {
      headers: { 'X-IG-App-ID': '936619743392459' },
      credentials: 'include',
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.user && j.user.username) || null;
  } catch (e) { return null; }
}"""

PROFILE_PIC_JS = r"""() => {
  const imgs = Array.from(document.querySelectorAll('img[alt]'));
  for (const img of imgs) {
    const m = (img.getAttribute('alt') || '').match(/^([A-Za-z0-9._]+)'s profile picture/);
    if (m) return m[1];
  }
  return null;
}"""


def detect_logged_in_username(page):
    """尽力识别当前登录的用户名：页面自己的 current_user 接口 → 左侧
    导航资料锚点 → 头像 alt 文本。读不到返回 None（不算登录失败）。"""
    try:
        via_api = page.evaluate(CURRENT_USER_JS)
        if via_api:
            return via_api
    except Exception:
        pass
    try:
        via_nav = page.evaluate(extract.NAV_PROFILE_USERNAME_JS)
        if via_nav:
            return via_nav
    except Exception:
        pass
    try:
        via_dom = page.evaluate(PROFILE_PIC_JS)
        if via_dom:
            return via_dom
    except Exception:
        pass
    return None


def collect_login_signals(page, context):
    """采集一组登录核验信号（只有布尔、URL 和标题，绝不含任何 cookie 值）。"""
    dom = {'title': '', 'hasVisiblePasswordInput': False, 'hasLoginForm': False,
           'hasProfileNavSignal': False, 'bodyText': ''}
    try:
        got = page.evaluate(LOGIN_SIGNALS_JS)
        if isinstance(got, dict):
            dom = got
    except Exception:
        pass  # 页面跳转中：信号保持空，分类器会走 retry/not_confirmed
    url = page.url
    has_sessionid = False
    try:
        cks = context.cookies(BASE_URL + '/')
        has_sessionid = any(c.get('name') == 'sessionid' for c in cks)
    except Exception:
        pass
    stop = login_guard.detect_stop_page({'url': url, 'text': dom.get('bodyText') or ''})
    return {
        'url': url,
        'title': dom.get('title') or '',
        'urlIsLogin': bool(login_guard.LOGIN_URL_RE.search(url)),
        'hasVisiblePasswordInput': bool(dom.get('hasVisiblePasswordInput')),
        'hasLoginForm': bool(dom.get('hasLoginForm')),
        'hasProfileNavSignal': bool(dom.get('hasProfileNavSignal')),
        'hasCheckpointSignal': bool(stop and stop['reason'] == 'checkpoint'),
        'hasSessionidCookie': has_sessionid,
        'hasUsername': False,
    }


def check_stop(page):
    """页面停止条件检测：验证/检查点、登录墙、限流。命中返回
    {'reason', 'detail'}，否则 None。"""
    text = ''
    try:
        text = page.evaluate(
            "() => ((document.body && document.body.innerText) || '').slice(0, 4000)")
    except Exception:
        pass
    return login_guard.detect_stop_page({'url': page.url, 'text': text})


def _debug_stamp(d):
    return d.strftime('%Y%m%d-%H%M%S')


def save_login_debug_evidence(page, context, out_dir, info=None):
    """核验失败时把“脚本眼里的页面”存成证据：out/debug-<时间>.png 截图
    + 同名 .json（只有核验信号、候选文件名、上下文 cookie 名字——绝不含
    任何 cookie 值、不存页面 HTML）。"""
    info = info or {}
    os.makedirs(out_dir, exist_ok=True)
    stamp = _debug_stamp(datetime.now())
    png_file = os.path.join(out_dir, 'debug-' + stamp + '.png')
    json_file = os.path.join(out_dir, 'debug-' + stamp + '.json')
    try:
        page.screenshot(path=png_file, timeout=10000)
    except Exception:
        pass
    cookie_names = []
    try:
        cks = context.cookies()
        cookie_names = sorted({c['name'] for c in cks})
    except Exception:
        pass
    s = info.get('signals') or {}
    record = {
        'savedAt': datetime.now().isoformat(),
        'verdict': info.get('reason') or '',
        'candidateFile': info.get('candidateLabel'),
        'signals': {
            'url': s.get('url') or '',
            'title': s.get('title') or '',
            'urlIsLogin': bool(s.get('urlIsLogin')),
            'hasVisiblePasswordInput': bool(s.get('hasVisiblePasswordInput')),
            'hasLoginForm': bool(s.get('hasLoginForm')),
            'hasProfileNavSignal': bool(s.get('hasProfileNavSignal')),
            'hasCheckpointSignal': bool(s.get('hasCheckpointSignal')),
            'hasSessionidCookie': bool(s.get('hasSessionidCookie')),
            'hasUsername': bool(s.get('hasUsername')),
        },
        'cookieNames': cookie_names,
    }
    try:
        with open(json_file, 'w', encoding='utf-8') as f:
            json.dump(record, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    print('IG 到底给脚本看了什么，看 out/debug-*.png 这张截图。')
    print('本次调试证据：' + png_file + '（截图）；' + json_file + '（核验信号，只有名字没有值）')
    if info.get('headed'):
        print('浏览器会多停留约 5 秒，你可以瞥一眼窗口里的页面再关。')
        _sleep(5)
    return {'pngFile': png_file, 'jsonFile': json_file}


def verify_login(page, context, out_dir='out', candidate_label=None, headed=True):
    """导入/自动模式的登录核验（基于证据，不凭单一信号下结论）：
    打开首页 → 等 load + 约 2.5 秒安定 → 关插屏 → 采集信号 → 分类；
    登录墙或不明确时等 3 秒刷新重看一次（共两轮），第二轮仍是严格
    登录墙才判 session_expired；检查点直接按 checkpoint 停；无法确认
    按 not_logged_in 停。失败结论一律先存调试截图+信号 JSON 再返回。
    返回 {'ok': True, 'username': str|None} 或
    {'ok': False, 'reason': session_expired|checkpoint|not_logged_in|network_error}。"""
    try:
        page.goto(BASE_URL + '/', wait_until='domcontentloaded', timeout=NAV_TIMEOUT_MS)
    except Exception:
        return {'ok': False, 'reason': 'network_error'}
    try:
        page.wait_for_load_state('load', timeout=15000)
    except Exception:
        pass
    _sleep(2.5)

    last_signals = None
    for pass_num in (1, 2):
        dismiss_interstitials(page)
        signals = collect_login_signals(page, context)
        uname = detect_logged_in_username(page)
        signals['hasUsername'] = bool(uname)
        last_signals = signals
        verdict = login_guard.classify_login_signals(signals, pass_num)
        v = verdict['verdict']
        if v == 'logged_in':
            return {'ok': True, 'username': uname or None}
        if v == 'checkpoint':
            save_login_debug_evidence(page, context, out_dir, {
                'reason': 'checkpoint', 'signals': signals,
                'candidateLabel': candidate_label, 'headed': headed})
            return {'ok': False, 'reason': 'checkpoint'}
        if v == 'retry' and pass_num < 2:
            _sleep(3)
            try:
                page.reload(wait_until='domcontentloaded', timeout=NAV_TIMEOUT_MS)
            except Exception:
                pass
            try:
                page.wait_for_load_state('load', timeout=15000)
            except Exception:
                pass
            _sleep(2.5)
            continue
        reason = 'session_expired' if v == 'session_expired' else 'not_logged_in'
        save_login_debug_evidence(page, context, out_dir, {
            'reason': reason, 'signals': signals,
            'candidateLabel': candidate_label, 'headed': headed})
        return {'ok': False, 'reason': reason}
    save_login_debug_evidence(page, context, out_dir, {
        'reason': 'not_logged_in', 'signals': last_signals,
        'candidateLabel': candidate_label, 'headed': headed})
    return {'ok': False, 'reason': 'not_logged_in'}
