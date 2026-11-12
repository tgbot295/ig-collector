# -*- coding: utf-8 -*-
"""本地 IG 采集引擎 · Python 核心版（原型）：在脚本自己的浏览器里用
卖家 cookie 文件登录，按关键词先找卖货博主、再采他们帖子下面的意向
评论，结果写成本地 JSON + 两列客户名单 CSV。移植自 JS 版 collector.js。

带上的三处实地修复（JS 版的病，Python 版不继承）：
- FIX A：文案行剔除（extract.filter_comment_rows）——以前每条帖子恒
  “评论共 1 条”，那条就是帖子文案被当成了评论。
- FIX B：评论展开点击 + 定向滚动（extract.collect_post_comments）——
  先点“查看全部评论/Load more”，滚动滚文案行的可滚动祖先。
- FIX C：低产量自检 + 博主粉丝 meta 解析（bloggers
  .parse_followers_from_meta 第一优先）——页面自报评论数和实际读到的
  差太多时自动存 out/debug-post-<code>.png/.json 证据。

红线（写死）：
- 登录账号命中主号黑名单（login_guard.DEFAULT_BLOCKLIST）立即中止；
- 动作间隔随机 3–6 秒；遇到验证/登录墙/限流页立即停，保存已采数据，
  不重试硬闯；
- 缺字段给 None，绝不编造；任何日志不出现 cookie 的值/密码/邮箱。
"""
import json
import os
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import bloggers
import browser_bits
import cookies_parse
import extract
import filters
import intent as intent_mod
import leads_out
import login_guard

HERE = Path(__file__).resolve().parent
BASE_URL = 'https://www.instagram.com'
COOKIES_DIR_DEFAULT = HERE / 'cookies'
OUT_DIR = HERE / 'out'
BLOCKLIST = login_guard.DEFAULT_BLOCKLIST

NAV_TIMEOUT_MS = browser_bits.NAV_TIMEOUT_MS
ACTION_TIMEOUT_MS = browser_bits.ACTION_TIMEOUT_MS

# 限量（与 JS 版 config.js 同口径；博主候选阶段按实地多样性修正放大：
# 快速认人最多开 60 条、候选人上限 30，JS 版是 30/20）
POSTS_DEFAULT, POSTS_MAX = 50, 50
COMMENTS_DEFAULT, COMMENTS_MAX = 50, 200
SCROLL_ROUNDS_MAX = 15
MIN_FOLLOWERS_DEFAULT, MIN_FOLLOWERS_MAX = 10000, 100000000
BLOGGERS_DEFAULT, BLOGGERS_MAX = 5, 20
POSTS_PER_BLOGGER_DEFAULT, POSTS_PER_BLOGGER_MAX = 10, 50
CANDIDATE_POSTS = 60
FAST_PASS_POSTS = 60
OWNERS_MAX = 30
GRID_SCROLL_ROUNDS = 6
MAX_KEYWORDS = 10


def tags_url(keyword):
    return BASE_URL + '/explore/tags/' + quote(keyword, safe='') + '/'


def human_pause():
    time.sleep(random.uniform(3.0, 6.0))


def small_pause():
    time.sleep(random.uniform(1.2, 2.5))


def print_usage():
    print('\n'.join([
        '本地 IG 采集引擎 · Python 核心版 — 用法：',
        '',
        ' py collector.py --keyword <关键词> [参数]',
        ' py collector.py --check-cookies   只体检 cookie 文件（不登录、不采集）',
        '',
        '参数：',
        ' --keyword 话题关键词，如 downjacket（可带空格/#，会自动处理成话题名）。',
        '    可重复写多个（一轮最多 10 个），也可用英文逗号分隔，如',
        '    --keyword downjacket,pufferjacket；--keywords 是同义写法。',
        '    多个关键词在同一个浏览器会话里按顺序跑（只登录一次）。',
        ' --posts 只在直采模式（--no-blogger-mode）下用：每个关键词最多采',
        '    多少条话题帖，默认 50。博主模式下每词预算是 博主数 × 每博主帖数。',
        ' --comments 每条帖子最多读多少条评论，默认 50。',
        '博主模式（默认开）：先按关键词找卖货博主（商家号、粉丝够多），再采',
        '    他们帖子下面的意向评论。某个关键词一个合格博主都没筛到时，',
        '    自动回退到话题帖直采，不会空手。',
        ' --no-blogger-mode 关掉博主模式，回到话题帖直采（--posts 生效）。',
        ' --min-followers N 入选博主的最低粉丝数，默认 10000。粉丝数读不到',
        '    的博主一律不入选（要的是“粉丝量比较多”，必须是看得见的数）。',
        ' --bloggers N 每个关键词最多选几个博主，默认 5，上限 20。',
        ' --posts-per-blogger N 每个选中博主最多采几条帖子，默认 10，上限 50。',
        ' --max-age-days N 只采最近 N 天内发布的帖子，默认 365；0 = 不限。',
        '    发布时间读不到的照常采。',
        ' --keep-all 关掉评论意向预筛（默认只保留问购买/问价格/问运费/问尺码）。',
        ' --merchant-filter 打开商家帖筛选（默认关）：只采文案带售卖信号的帖子。',
        ' --import-session <文件> 用会话文件直登（.storage.json）。',
        ' --import-cookies <文件> 用 cookie 文件直登（JSON/Netscape/Cookie头都认）。',
        ' --cookies-dir <目录> 自动模式扫描的 cookie 文件夹，默认 ./cookies。',
        ' --browser <chrome|msedge|chromium> 强制只用某个浏览器；不给时依次试',
        '    本机 Google Chrome、Microsoft Edge、Playwright 自带 Chromium。',
        ' --headless 无头模式（仅调试用）。',
        ' --help 显示本说明',
        '',
        '自动模式（默认）：只给 --keyword 时，脚本按顺序自动找登录来源：',
        'cookies/ 文件夹里的卖家 cookie 文件（文件名随便，按文件名顺序在登录',
        '核验阶段逐个试，失效的换下一个，命中主号黑名单立即中止）→ 本目录',
        'cookies.txt / cookies.json。都没有就显示本说明退出，不会自己乱登。',
        '采集结果写到 out/ 目录：collect-*.json 是完整记录，leads-*.csv 是',
        '两列客户名单（用户链接、评论内容）。',
    ]))


def clean_keyword(raw):
    return re.sub(r'\s+', '', re.sub(r'^#+', '', str(raw or ''))).strip()


def normalize_keywords(inputs):
    """把多次 --keyword/--keywords 的原始值收拾成话题列表：逗号分隔、
    清洗（去 # 和空格）、去空、去重、最多 10 个。"""
    out = []
    seen = set()
    for raw in inputs or []:
        for piece in str(raw if raw is not None else '').split(','):
            kw = clean_keyword(piece)
            if not kw or kw in seen:
                continue
            seen.add(kw)
            out.append(kw)
            if len(out) >= MAX_KEYWORDS:
                return out
    return out


def _parse_int(v):
    """JS parseInt 口径：取开头的整数前缀，取不到给 None。"""
    if v is None:
        return None
    m = re.match(r'^\s*[+-]?\d+', str(v))
    if not m:
        return None
    try:
        return int(m.group(0))
    except ValueError:
        return None


def parse_args(argv):
    args = {
        'keyword': '', 'keywords': [],
        'posts': POSTS_DEFAULT, 'comments': COMMENTS_DEFAULT,
        'headless': False, 'help': False,
        'importSession': '', 'importCookies': '',
        'cookiesDir': str(COOKIES_DIR_DEFAULT), 'browser': '',
        'checkCookies': False, 'maxAgeDays': 365,
        'keepAll': False, 'merchantFilter': False,
        'bloggerMode': True, 'minFollowers': MIN_FOLLOWERS_DEFAULT,
        'bloggers': BLOGGERS_DEFAULT, 'postsPerBlogger': POSTS_PER_BLOGGER_DEFAULT,
    }
    keyword_inputs = []
    argv = list(argv or [])
    i = 0

    def next_val():
        nonlocal i
        i += 1
        return argv[i] if i < len(argv) else ''

    while i < len(argv):
        a = argv[i]
        if a in ('--help', '-h'):
            args['help'] = True
        elif a == '--check-cookies':
            args['checkCookies'] = True
        elif a == '--headless':
            args['headless'] = True
        elif a == '--keep-all':
            args['keepAll'] = True
        elif a == '--merchant-filter':
            args['merchantFilter'] = True
        elif a == '--no-merchant-filter':
            args['merchantFilter'] = False  # 旧参数，现为无操作（默认就是关的）
        elif a == '--blogger-mode':
            args['bloggerMode'] = True
        elif a == '--no-blogger-mode':
            args['bloggerMode'] = False
        elif a == '--min-followers':
            args['minFollowers'] = _parse_int(next_val())
        elif a.startswith('--min-followers='):
            args['minFollowers'] = _parse_int(a[len('--min-followers='):])
        elif a == '--bloggers':
            args['bloggers'] = _parse_int(next_val())
        elif a.startswith('--bloggers='):
            args['bloggers'] = _parse_int(a[len('--bloggers='):])
        elif a == '--posts-per-blogger':
            args['postsPerBlogger'] = _parse_int(next_val())
        elif a.startswith('--posts-per-blogger='):
            args['postsPerBlogger'] = _parse_int(a[len('--posts-per-blogger='):])
        elif a == '--max-age-days':
            args['maxAgeDays'] = _parse_int(next_val())
        elif a.startswith('--max-age-days='):
            args['maxAgeDays'] = _parse_int(a[len('--max-age-days='):])
        elif a == '--import-session':
            args['importSession'] = str(next_val() or '').strip()
        elif a.startswith('--import-session='):
            args['importSession'] = a[len('--import-session='):].strip()
        elif a == '--import-cookies':
            args['importCookies'] = str(next_val() or '').strip()
        elif a.startswith('--import-cookies='):
            args['importCookies'] = a[len('--import-cookies='):].strip()
        elif a == '--cookies-dir':
            args['cookiesDir'] = str(next_val() or '').strip() or str(COOKIES_DIR_DEFAULT)
        elif a.startswith('--cookies-dir='):
            args['cookiesDir'] = a[len('--cookies-dir='):].strip() or str(COOKIES_DIR_DEFAULT)
        elif a == '--browser':
            args['browser'] = str(next_val() or '').strip().lower()
        elif a.startswith('--browser='):
            args['browser'] = a[len('--browser='):].strip().lower()
        elif a == '--keyword':
            keyword_inputs.append(next_val() or '')
        elif a == '--keywords':
            keyword_inputs.append(next_val() or '')
        elif a.startswith('--keyword='):
            keyword_inputs.append(a[len('--keyword='):])
        elif a.startswith('--keywords='):
            keyword_inputs.append(a[len('--keywords='):])
        elif a == '--posts':
            args['posts'] = _parse_int(next_val())
        elif a.startswith('--posts='):
            args['posts'] = _parse_int(a[len('--posts='):])
        elif a == '--comments':
            args['comments'] = _parse_int(next_val())
        elif a.startswith('--comments='):
            args['comments'] = _parse_int(a[len('--comments='):])
        i += 1

    args['keywords'] = normalize_keywords(keyword_inputs)
    args['keyword'] = args['keywords'][0] if args['keywords'] else ''
    if not args['browser']:
        args['browser'] = os.environ.get('IG_COLLECTOR_BROWSER', '').strip().lower()
    if args['posts'] is None or args['posts'] < 1:
        args['posts'] = POSTS_DEFAULT
    args['posts'] = min(args['posts'], POSTS_MAX)
    if args['comments'] is None or args['comments'] < 1:
        args['comments'] = COMMENTS_DEFAULT
    args['comments'] = min(args['comments'], COMMENTS_MAX)
    if args['maxAgeDays'] is None or args['maxAgeDays'] < 0:
        args['maxAgeDays'] = 365
    if args['minFollowers'] is None or args['minFollowers'] < 0:
        args['minFollowers'] = MIN_FOLLOWERS_DEFAULT
    args['minFollowers'] = min(args['minFollowers'], MIN_FOLLOWERS_MAX)
    if args['bloggers'] is None or args['bloggers'] < 1:
        args['bloggers'] = BLOGGERS_DEFAULT
    args['bloggers'] = min(args['bloggers'], BLOGGERS_MAX)
    if args['postsPerBlogger'] is None or args['postsPerBlogger'] < 1:
        args['postsPerBlogger'] = POSTS_PER_BLOGGER_DEFAULT
    args['postsPerBlogger'] = min(args['postsPerBlogger'], POSTS_PER_BLOGGER_MAX)
    return args


# --check-cookies 体检：逐个文件只报文件名、格式、cookie 名字（绝不报值）、
# 有没有 sessionid 和结论。
def run_check_cookies(args):
    targets = []
    for cand in cookies_parse.scan_cookies_dir(args['cookiesDir']):
        targets.append({'fullPath': cand['fullPath'], 'label': cand['file']})
    for root_name in ('cookies.txt', 'cookies.json'):
        root_path = HERE / root_name
        if root_path.exists():
            targets.append({'fullPath': str(root_path), 'label': root_name + '（根目录）'})
    print('cookie 文件体检（只报文件名、格式和 cookie 名字，绝不报任何值）：')
    if not targets:
        print('（一个文件都没找到：cookies 文件夹是空的，本目录也没有 cookies.txt / cookies.json）')
        print('先把卖家给的 cookie 文件放进 cookies 文件夹（文件名随便），再跑一次。')
        return 0
    for t in targets:
        d = cookies_parse.diagnose_file(t['fullPath'], t['label'])
        names = '、'.join(d['cookieNames']) if d['cookieNames'] else '（无）'
        account_part = '；账号：' + d['detectedUsername'] if d.get('detectedUsername') else ''
        if d['ok']:
            print('[可用] ' + d['file'] + ' — 格式：' + d['format'] + '；cookie：' + names +
                  '；sessionid：有' + account_part)
        else:
            print('[不可用] ' + d['file'] + ' — 格式：' + d['format'] + '；cookie：' + names +
                  '；sessionid：' + ('有' if d['hasSessionid'] else '无') + account_part +
                  '；原因：' + d['reason'])
    return 0


# ================= 采集流水线（博主模式三步 / 话题直采共用） =================

class StopRun(Exception):
    """停止整轮采集（已采数据照常保存）。reason 是 guard 的停止原因，
    exit_code 是进程退出码（主号黑名单=2，浏览器/库缺失=1，其余=0）。"""

    def __init__(self, reason, exit_code=0):
        super().__init__(reason)
        self.reason = reason
        self.exit_code = exit_code


class CollCtx:
    def __init__(self, args, output):
        self.args = args
        self.output = output
        self.run_checked_urls = set()  # 本轮已处理过的帖子链接（跨关键词去重）

    def stop_with(self, reason, exit_code=0):
        self.output['stats']['stopped'] = reason
        self.output['stats']['stoppedLabel'] = login_guard.reason_label(reason)
        print('已停止：' + self.output['stats']['stoppedLabel'] + '（已保存目前采到的数据）')
        raise StopRun(reason, exit_code)

    def stop_with_silent(self, reason):
        """只记停止原因不打印“已停止”行（浏览器都没起来时用），不抛异常，
        调用方紧接着 finish 收尾。"""
        self.output['stats']['stopped'] = reason
        self.output['stats']['stoppedLabel'] = login_guard.reason_label(reason)


def save_output(output, file_tag):
    """收尾保存两份文件（同一时间戳对应）：
    1) collect-<标记>-<时间>.json：本轮完整记录。
    2) leads-<标记>-<时间>.csv：本轮名单，两列（用户链接、评论内容），
       多关键词时跨词合并去重——这就是给人看的最终交付物。"""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%S')
    file = OUT_DIR / ('collect-' + file_tag + '-' + ts + '.json')
    with open(file, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    rows = leads_out.build_leads_rows(output['items'])
    leads_file = OUT_DIR / ('leads-' + file_tag + '-' + ts + '.csv')
    with open(leads_file, 'w', encoding='utf-8', newline='') as f:
        f.write(leads_out.to_csv(rows))
    return {'file': str(file), 'leadsFile': str(leads_file), 'leadsCount': len(rows)}


def save_post_debug_evidence(page, link, meta, stated_count, harvested_count):
    """【FIX C】单帖调试证据：评论读不出来/读得太少时，把“脚本眼里的
    页面”存下来定性（out/debug-post-<shortCode>.png + 同名 .json）。
    JSON 只有页面结构计数、自报/实读评论数、URL、标题——不存 HTML、
    不存任何 cookie/账号值。"""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tag = link.get('shortCode') or 'post'
    png_file = OUT_DIR / ('debug-post-' + tag + '.png')
    json_file = OUT_DIR / ('debug-post-' + tag + '.json')
    try:
        page.screenshot(path=str(png_file), timeout=10000)
    except Exception:
        pass  # 截不到图不影响结论，JSON 照样写
    title = ''
    try:
        title = page.title()
    except Exception:
        pass
    counts = (meta or {}).get('counts') or {}
    record = {
        'savedAt': datetime.now().isoformat(),
        'url': link['url'],
        'title': title,
        'counts': {
            'anchorsTotal': counts.get('anchorsTotal') or 0,
            'profileAnchors': counts.get('profileAnchors') or 0,
            'commentRowCandidates': counts.get('commentRowCandidates') or 0,
        },
        'hasCommentsContainer': bool((meta or {}).get('hasCommentsContainer')),
        'statedCount': stated_count,
        'harvestedCount': harvested_count,
    }
    try:
        with open(json_file, 'w', encoding='utf-8') as f:
            json.dump(record, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    return {'pngFile': str(png_file), 'jsonFile': str(json_file)}


_HREFS_JS = "() => Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href'))"


def _page_hrefs(page):
    try:
        return page.evaluate(_HREFS_JS) or []
    except Exception:
        return []


def process_post(page, link, kw, ctx, kw_stats, index, total):
    """逐帖全套处理（直采和博主模式共用）：打开帖子 → 停检 → 收割 →
    新鲜度筛选 → 商家筛选（默认关）→ 文案行剔除 → 意向预筛 → 进结果+计数。
    触发停止条件时 ctx.stop_with 抛 StopRun，调用方不用再判断。"""
    args = ctx.args
    output = ctx.output
    try:
        page.goto(link['url'], wait_until='domcontentloaded', timeout=NAV_TIMEOUT_MS)
    except Exception:
        print('帖子 ' + str(index + 1) + '/' + str(total) + ' 打开失败，跳过：' + link['url'])
        human_pause()
        return
    human_pause()

    stop = browser_bits.check_stop(page)
    if stop:
        ctx.stop_with(stop['reason'])

    hv = extract.harvest_post(page, link, args['comments'])
    post = hv['post']
    post['keyword'] = kw

    # 筛选一：新鲜度。发布时间已知且超过 --max-age-days 的，整帖跳过；
    # 发布时间未知的照常采（已标 unknown）。
    age_decision = filters.decide_post_age({
        'timestamp': post.get('timestamp'),
        'now': datetime.now(timezone.utc).isoformat(),
        'maxAgeDays': args['maxAgeDays'],
    })
    if age_decision['action'] == 'skip':
        output['stats']['postsSkippedOld'] += 1
        kw_stats['postsSkippedOld'] += 1
        print('跳过旧帖 ' + str(link['shortCode']) + '：发布于 ' +
              str(post.get('timestamp'))[:10] + '（超过 ' + str(args['maxAgeDays']) + ' 天）')
        human_pause()
        return
    if not post.get('timestamp'):
        print('帖子 ' + str(link['shortCode']) + ' 发布时间未知，照常采集。')

    # 筛选二：商家帖（默认关）。售卖信号照常挂在帖子条目上供下游复用；
    # 只有显式加 --merchant-filter 时，无信号的路人帖才跳过。
    m_signals = filters.merchant_signals_of(post.get('caption'))
    if args['merchantFilter'] and not m_signals:
        output['stats']['postsSkippedNonMerchant'] += 1
        kw_stats['postsSkippedNonMerchant'] += 1
        print('跳过非商家帖 @' + (post.get('ownerUsername') or '未知') + '（文案无售卖信号）')
        human_pause()
        return
    post['merchantSignals'] = m_signals

    # 【FIX A】文案行剔除：收割到的行里“帖主本人 + 正文==文案”的那行
    # 是文案，不是评论（以前每条帖子恒“评论共 1 条”就是它）。
    all_comments = extract.filter_comment_rows(
        hv['comments'], post.get('ownerUsername'), post.get('caption'))
    harvested = len(all_comments)
    stated = hv.get('statedCount')

    # 【FIX C】低产量自检：页面自报评论数 >= 5、实际读到的不到它的三成
    # （且不到 2 条保底线），说明读取方式和真实页面对不上——存证据并
    # 明说，绝不把这种帖子当“没评论”蒙混过去。作者没读出且评论 0 条
    # 的老触发条件一并保留。
    low_yield = (isinstance(stated, (int, float)) and not isinstance(stated, bool)
                 and stated >= 5 and harvested < max(2, stated * 0.3))
    if low_yield or extract.needs_post_debug(post, all_comments):
        ev = save_post_debug_evidence(page, link, hv.get('meta'), stated, harvested)
        if low_yield:
            print('评论读取异常 ' + str(link['shortCode']) + '：页面显示约 ' +
                  str(int(stated)) + ' 条，只读到 ' + str(harvested) +
                  ' 条，已存证据 ' + ev['pngFile'])
        else:
            print('这条帖子没读出作者和评论，已存调试证据：' + ev['pngFile'] +
                  ' 和 ' + ev['jsonFile'] + '（只有页面结构计数）。')

    # 筛选三：评论意向预筛（默认开）。只有带购买意向的评论进结果，
    # 意向类别挂在每条保留评论的 intentTypes 上；--keep-all 时全保留。
    filtered = intent_mod.filter_comments_by_intent(all_comments, args['keepAll'])
    comments = filtered['kept']
    post['latestComments'] = comments
    output['items'].append(post)
    output['items'].extend(comments)
    output['stats']['postsCollected'] += 1
    kw_stats['postsCollected'] += 1
    output['stats']['commentsCollected'] += len(comments)
    output['stats']['commentsSeen'] += filtered['seen']
    kw_stats['commentsSeen'] += filtered['seen']
    output['stats']['commentsKeptIntent'] += filtered['intentCount']
    kw_stats['commentsKeptIntent'] += filtered['intentCount']
    if args['keepAll']:
        print('已采集帖子 ' + str(index + 1) + '/' + str(total) + '：@' +
              (post.get('ownerUsername') or '未知') + '，评论共 ' + str(filtered['seen']) +
              ' 条（--keep-all 全部保留，其中意向 ' + str(filtered['intentCount']) + ' 条）')
    else:
        print('已采集帖子 ' + str(index + 1) + '/' + str(total) + '：@' +
              (post.get('ownerUsername') or '未知') + '，评论共 ' + str(filtered['seen']) +
              ' 条，意向 ' + str(filtered['intentCount']) + ' 条')
    human_pause()


def collect_tag_links(page, kw, ctx, limit):
    """打开话题页并滚动收集帖子链接（上限 limit 条）。触发停止抛 StopRun。"""
    print('正在打开话题页：#' + kw)
    try:
        page.goto(tags_url(kw), wait_until='domcontentloaded', timeout=NAV_TIMEOUT_MS)
    except Exception as e:
        print('打开话题页失败：' + str(e).split('\n')[0])
        ctx.stop_with('network_error')
    human_pause()

    stop = browser_bits.check_stop(page)
    if stop:
        ctx.stop_with(stop['reason'])

    link_map = {}
    for _round in range(SCROLL_ROUNDS_MAX):
        if len(link_map) >= limit:
            break
        for l in extract.extract_post_links_from_hrefs(_page_hrefs(page)):
            link_map.setdefault(l['shortCode'], l)
        if len(link_map) >= limit:
            break
        try:
            page.mouse.wheel(0, 1600)
        except Exception:
            pass
        small_pause()
        stop = browser_bits.check_stop(page)
        if stop:
            ctx.stop_with(stop['reason'])
    return list(link_map.values())


def collect_from_hashtag(page, kw, ctx, kw_stats):
    """话题帖直采：话题页链接 → 逐帖全套处理（本轮已处理过的链接跳过）。"""
    args = ctx.args
    got = collect_tag_links(page, kw, ctx, args['posts'])
    links = [l for l in got if l['url'] not in ctx.run_checked_urls][:args['posts']]
    kw_stats['postsFound'] += len(links)
    ctx.output['stats']['postsFound'] += len(links)
    print('话题页共找到帖子链接 ' + str(len(links)) + ' 条，开始逐条采集…')
    for i, link in enumerate(links):
        ctx.run_checked_urls.add(link['url'])
        process_post(page, link, kw, ctx, kw_stats, i, len(links))


def collect_candidate_owners(page, kw, ctx):
    """博主模式第一步（找候选人）：话题页收集链接后，快速打开帖子只读
    作者+文案（不读评论），按首次出现收齐候选人（带一句文案给后面判
    商家补信号用）。返回 [{'username', 'captions'}]。"""
    print('博主模式：先在话题里找卖货博主（扫帖认人中）…')
    got = collect_tag_links(page, kw, ctx, CANDIDATE_POSTS)
    pass_links = got[:FAST_PASS_POSTS]
    print('话题页收集到 ' + str(len(got)) + ' 条帖子链接，快速打开其中 ' +
          str(len(pass_links)) + ' 条认发帖人（不读评论）…')
    owners = []
    seen = set()
    for i, link in enumerate(pass_links):
        if len(owners) >= OWNERS_MAX:
            break
        try:
            page.goto(link['url'], wait_until='domcontentloaded', timeout=NAV_TIMEOUT_MS)
        except Exception:
            print('候选帖 ' + str(i + 1) + '/' + str(len(pass_links)) + ' 打开失败，跳过：' + link['url'])
            continue
        small_pause()
        stop = browser_bits.check_stop(page)
        if stop:
            ctx.stop_with(stop['reason'])
        data = extract.extract_post_data(page, link)
        uname = str((data['post'] or {}).get('ownerUsername') or '').strip()
        if uname and uname.lower() not in seen:
            seen.add(uname.lower())
            caption = data['post'].get('caption')
            owners.append({'username': uname, 'captions': [caption] if caption else []})
            print('博主候选人 ' + str(len(owners)) + '：@' + uname)
        small_pause()
    print('共找到博主候选人 ' + str(len(owners)) + ' 位，开始逐个看主页筛商家和粉丝数…')
    return owners


def evaluate_bloggers(page, owners, ctx):
    """博主模式第二步（评估博主）：逐个打开候选人主页，读粉丝数/商家
    标记/简介，逐行打印评估表，再按规则（商家 + 粉丝已知 + 达门槛）
    选博主。返回 (candidates, selected)。"""
    args = ctx.args
    candidates = []
    for owner in owners:
        try:
            page.goto(BASE_URL + '/' + quote(owner['username'], safe='') + '/',
                      wait_until='domcontentloaded', timeout=NAV_TIMEOUT_MS)
        except Exception:
            print('博主候选 @' + owner['username'] + ' 的主页打开失败，跳过。')
            continue
        small_pause()
        stop = browser_bits.check_stop(page)
        if stop:
            ctx.stop_with(stop['reason'])
        profile = extract.harvest_profile(page, owner['username'])
        cand = bloggers.evaluate_profile_candidate({
            'username': owner['username'],
            'followers': profile.get('followers'),
            'isBusiness': profile.get('isBusiness'),
            'category': profile.get('category'),
            'bio': profile.get('bio'),
            'captions': owner['captions'],
        })
        candidates.append(cand)
        f_txt = bloggers.format_followers_full(cand['followers'])
        sig_parts = list(cand['signals'])
        if cand['isBusiness']:
            sig_parts.insert(0, '商家号标记')
        sig_txt = '、'.join(sig_parts) if sig_parts else '无'
        if not cand['merchant']:
            print('博主候选 @' + cand['username'] + '：粉丝 ' + f_txt + '，商家✗ 跳过')
        elif cand['followers'] is None:
            print('博主候选 @' + cand['username'] + '：粉丝 未知，商家✓（信号：' + sig_txt +
                  '），但粉丝数读不到，跳过')
        elif cand['followers'] < args['minFollowers']:
            print('博主候选 @' + cand['username'] + '：粉丝 ' + f_txt + '，商家✓（信号：' + sig_txt +
                  '），粉丝不足（门槛 ' + bloggers.format_followers_full(args['minFollowers']) + '），跳过')
        else:
            print('博主候选 @' + cand['username'] + '：粉丝 ' + f_txt + '，商家✓（信号：' + sig_txt + '）')
        human_pause()
    selected = bloggers.select_bloggers(
        candidates, {'minFollowers': args['minFollowers'], 'topN': args['bloggers']})
    if selected:
        print('选中博主 ' + str(len(selected)) + ' 个：' +
              ' '.join('@' + b['username'] + '(' + bloggers.format_followers(b['followers']) + ')'
                       for b in selected))
    else:
        print('选中博主 0 个（要商家、且粉丝数看得见、≥ ' +
              bloggers.format_followers_full(args['minFollowers']) + '）。')
    return candidates, selected


def collect_from_bloggers(page, kw, selected, ctx, kw_stats):
    """博主模式第三步（采博主的帖子）：逐个选中博主开主页，从主页网格
    收帖子链接（滚几轮，封顶 postsPerBlogger），逐帖走和直采完全相同
    的全套处理。博主帖的 keyword 记成来源关键词。"""
    args = ctx.args
    for bi, blogger in enumerate(selected):
        print('正在采博主 @' + blogger['username'] + '（' +
              bloggers.format_followers(blogger['followers']) + '粉丝）的帖子（第 ' +
              str(bi + 1) + '/' + str(len(selected)) + ' 个博主）…')
        try:
            page.goto(BASE_URL + '/' + quote(blogger['username'], safe='') + '/',
                      wait_until='domcontentloaded', timeout=NAV_TIMEOUT_MS)
        except Exception:
            print('博主 @' + blogger['username'] + ' 的主页打开失败，跳过这个博主。')
            continue
        human_pause()
        stop = browser_bits.check_stop(page)
        if stop:
            ctx.stop_with(stop['reason'])
        link_map = {}
        for _round in range(GRID_SCROLL_ROUNDS):
            if len(link_map) >= args['postsPerBlogger']:
                break
            for l in extract.extract_post_links_from_hrefs(_page_hrefs(page)):
                link_map.setdefault(l['shortCode'], l)
            if len(link_map) >= args['postsPerBlogger']:
                break
            try:
                page.mouse.wheel(0, 1600)
            except Exception:
                pass
            small_pause()
            stop = browser_bits.check_stop(page)
            if stop:
                ctx.stop_with(stop['reason'])
        grid_links = list(link_map.values())
        if not grid_links:
            print('博主 @' + blogger['username'] + ' 主页没读到帖子，跳过。')
            continue
        links = [l for l in grid_links
                 if l['url'] not in ctx.run_checked_urls][:args['postsPerBlogger']]
        kw_stats['postsFound'] += len(links)
        ctx.output['stats']['postsFound'] += len(links)
        print('博主 @' + blogger['username'] + ' 主页找到帖子 ' + str(len(links)) + ' 条，开始逐条采集…')
        for i, link in enumerate(links):
            ctx.run_checked_urls.add(link['url'])
            process_post(page, link, kw, ctx, kw_stats, i, len(links))


def resolve_candidates(args):
    """开浏览器之前把登录来源定下来。返回 (candidates, import_mode)：
    candidates = [{'label', 'storageState', 'detectedUsername'}]。
    来源顺序（自动模式）：cookies/ 文件夹 → 本目录 cookies.txt /
    cookies.json。显式 --import-* 时只有那一个候选。
    定不下来时打印说明并返回 (None, import_mode)，调用方退出。"""
    if args['importSession'] and args['importCookies']:
        print('错误：--import-session 和 --import-cookies 只能选一个。')
        return None, None
    import_file = args['importSession'] or args['importCookies']
    if import_file:
        import_mode = 'import-session' if args['importSession'] else 'import-cookies'
        try:
            detailed = cookies_parse.load_session_file_detailed(import_file)
        except Exception as e:
            print('错误：' + str(e))
            return None, import_mode
        summ = cookies_parse.summarize_state(detailed['storageState'])
        print('已读取会话文件（' + import_mode + '）：共 ' + str(summ['cookieCount']) +
              ' 个 cookie，包含 ' + '、'.join(summ['cookieNames']) + '。文件等于账号钥匙，只放本地。')
        if detailed.get('detectedUsername'):
            print('文件里附带的账号名：@' + detailed['detectedUsername'] +
                  '（仅作预检，登录后还会再核验实际账号）')
        return [{'label': import_file, 'storageState': detailed['storageState'],
                 'detectedUsername': detailed.get('detectedUsername')}], import_mode

    # 自动模式 1) cookies/ 文件夹
    dir_scan = cookies_parse.load_candidates(args['cookiesDir'])
    for u in dir_scan['unparseable']:
        print('cookies 文件夹里的文件「' + u['file'] + '」跳过（' + u['reason'] + '），不会使用它。')
    if dir_scan['parseable']:
        candidates = [{'label': 'cookies/' + c['file'], 'storageState': c['storageState'],
                       'detectedUsername': c.get('detectedUsername')}
                      for c in dir_scan['parseable']]
        print('自动模式：在 cookies 文件夹里找到 ' + str(len(candidates)) +
              ' 个可用的会话文件，将在登录核验阶段按文件名顺序逐个试。')
        return candidates, None
    # 自动模式 2) 本目录 cookies.txt / cookies.json
    for root_name in ('cookies.txt', 'cookies.json'):
        root_path = HERE / root_name
        if not root_path.exists():
            continue
        try:
            detailed = cookies_parse.load_session_file_detailed(str(root_path))
            print('自动模式：使用本目录的 ' + root_name + ' 里的会话登录。')
            return [{'label': root_name, 'storageState': detailed['storageState'],
                     'detectedUsername': detailed.get('detectedUsername')}], None
        except Exception as e:
            print('本目录的 ' + root_name + ' 跳过（' + cookies_parse.reason_category(e) +
                  '），不会使用它。')
    print('自动模式没找到任何可用的登录来源：cookies 文件夹里没有能读的会话文件，')
    print('本目录也没有 cookies.txt / cookies.json。')
    print('先把卖家给的 cookie 文件放进 cookies 文件夹（文件名随便），')
    print('或者用 --import-session / --import-cookies 指定会话文件。')
    print_usage()
    return None, None


def run_collect(args):
    candidates, import_mode = resolve_candidates(args)
    if candidates is None:
        return 1

    # 黑名单预检：任一候选会话附带的账号名（卖家整行里的用户名）命中
    # 主号黑名单，在开浏览器之前就整轮中止（退出码 2），不试不登。
    bad = next((c for c in candidates
                if c.get('detectedUsername')
                and login_guard.is_blocked_username(c['detectedUsername'], BLOCKLIST)), None)
    if bad:
        print('错误：会话文件 ' + bad['label'] + ' 附带的账号 @' + bad['detectedUsername'] +
              ' 是受保护的主号，拒绝用它登录采集（还没打开浏览器就已中止）。')
        return 2

    file_tag = '_'.join(
        re.sub(r'[^A-Za-z0-9_-]+', '-', k) for k in args['keywords'])[:60] or args['keyword']
    output = {
        'keyword': args['keyword'],
        'keywords': args['keywords'],
        'collectedAt': datetime.now(timezone.utc).isoformat(),
        'source': 'local-collector-py',
        'items': [],
        'stats': {
            'account': None,
            'loginMode': import_mode or 'auto-cookies',
            'postsFound': 0,
            'postsCollected': 0,
            'postsSkippedOld': 0,
            'postsSkippedNonMerchant': 0,
            'commentsCollected': 0,
            'commentsSeen': 0,
            'commentsKeptIntent': 0,
            'stopped': None,
            'stoppedLabel': '',
            'byKeyword': {},
        },
    }
    ctx = CollCtx(args, output)

    def finish(code):
        saved = save_output(output, file_tag)
        s = output['stats']
        print('汇总：帖子采集 ' + str(s['postsCollected']) + ' 条，跳过旧帖 ' +
              str(s['postsSkippedOld']) + ' 条，跳过非商家帖 ' + str(s['postsSkippedNonMerchant']) +
              ' 条；评论共看到 ' + str(s['commentsSeen']) + ' 条，意向评论保留 ' +
              str(s['commentsKeptIntent']) + ' 条。')
        if s['stopped']:
            print('运行状态：' + json.dumps(
                {'stopped': s['stopped'], 'label': s['stoppedLabel'], 'file': saved['file']},
                ensure_ascii=False))
        else:
            print('运行状态：' + json.dumps(
                {'stopped': None, 'label': '采集完成', 'file': saved['file']},
                ensure_ascii=False))
        print('结果已保存：' + saved['file'])
        print('客户名单：共 ' + str(saved['leadsCount']) + ' 条 → ' + saved['leadsFile'] +
              '（只有两列：用户链接、评论内容）')
        return code

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print('未找到 Playwright 库。请先在本目录运行：py -m pip install -r requirements.txt'
              '（浏览器用本机现成的 Chrome / Edge，不用再单独下载内核）')
        ctx.stop_with_silent('playwright_missing')
        return finish(1)

    browser = None
    context = None
    try:
        with sync_playwright() as pw:
            try:
                browser, _cand = browser_bits.launch_browser(
                    pw, forced=args['browser'] or None, headless=args['headless'])
            except RuntimeError:
                print('没找到能用的浏览器：请装 Google Chrome（或确认 Edge 在），装好后重跑。')
                ctx.stop_with_silent('browser_launch_failed')
                return finish(1)

            # ---- 登录核验：候选会话按顺序逐个试 ----
            # 第一个核验通过的候选用它跑完整程；失效的报文件名换下一个；
            # 检查点是账号/网络层面的事，整轮停，不拿下一个号连环硬试。
            page = None
            username = None
            verified = False
            any_expired = False
            tried_labels = []
            for cand in candidates:
                if context is not None:
                    try:
                        context.close()
                    except Exception:
                        pass
                    context = None
                try:
                    context = browser_bits.build_context(
                        browser, cookies_parse.to_playwright_cookies(cand['storageState']))
                except Exception:
                    tried_labels.append(cand['label'])
                    print('会话文件 ' + cand['label'] + ' 打不开（浏览器上下文创建失败），换下一个候选试。')
                    continue
                page = context.pages[0] if context.pages else context.new_page()
                page.set_default_timeout(ACTION_TIMEOUT_MS)
                v = browser_bits.verify_login(
                    page, context, out_dir=str(OUT_DIR),
                    candidate_label=cand['label'], headed=not args['headless'])
                if v['ok']:
                    verified = True
                    username = v.get('username')
                    if username:
                        print('会话文件 ' + cand['label'] + ' 核验通过，当前登录账号：@' + username)
                    else:
                        print('会话文件 ' + cand['label'] + ' 核验通过：已登录（没识别出用户名，继续）。')
                    break
                if v['reason'] == 'network_error':
                    print('打开 Instagram 失败（网络问题）。')
                    ctx.stop_with('network_error')
                if v['reason'] == 'checkpoint':
                    ctx.stop_with('checkpoint')
                if v['reason'] == 'session_expired':
                    any_expired = True
                tried_labels.append(cand['label'] + '（' +
                                    ('session_expired' if v['reason'] == 'session_expired'
                                     else '未能确认登录态') + '）')
                print('会话文件 ' + cand['label'] +
                      (' 已失效（session_expired），换下一个候选试。'
                       if v['reason'] == 'session_expired'
                       else ' 未能确认登录态，换下一个候选试。'))
            if not verified:
                print('自动模式：候选会话全都没通过核验，已逐个试过：' + '、'.join(tried_labels))
                if any_expired:
                    print('请让卖家重新给一份有效的 cookie 文件放进 cookies 文件夹。')
                    ctx.stop_with('session_expired')
                print('没能确认登录态（不是判失效）：先看 out/debug-*.png 截图确认页面当时长什么样，再决定重跑还是换文件。')
                ctx.stop_with('not_logged_in')

            # 用户名没识别出来时再尽力补检一次（已登录照样继续）
            if not username:
                username = browser_bits.detect_logged_in_username(page)
            output['stats']['account'] = username
            print('当前登录账号：@' + username if username
                  else '当前已登录（没识别出用户名，继续采集）。')

            if login_guard.is_blocked_username(username, BLOCKLIST):
                print('错误：当前登录的是受保护的主号 @' + str(username) +
                      '，绝不能用主号采集，已立即中止。')
                print('请换专用小号的 cookie 文件后再运行。')
                ctx.stop_with('blocked_main_account', exit_code=2)

            # ---- 逐关键词搜帖采集（一个会话只登录一次，顺序跑完） ----
            for ki, kw in enumerate(args['keywords']):
                kw_stats = {
                    'postsFound': 0, 'postsCollected': 0, 'postsSkippedOld': 0,
                    'postsSkippedNonMerchant': 0, 'commentsSeen': 0,
                    'commentsKeptIntent': 0, 'bloggersEvaluated': 0, 'bloggersSelected': 0,
                }
                output['stats']['byKeyword'][kw] = kw_stats
                print('')
                print('===== 关键词 ' + str(ki + 1) + '/' + str(len(args['keywords'])) +
                      '：#' + kw + ' =====')
                if args['bloggerMode']:
                    owners = collect_candidate_owners(page, kw, ctx)
                    kw_stats['bloggersEvaluated'] = len(owners)
                    _cands, selected = evaluate_bloggers(page, owners, ctx)
                    kw_stats['bloggersSelected'] = len(selected)
                    if not selected:
                        print('该关键词没筛到符合的博主，回退到话题帖直采')
                        collect_from_hashtag(page, kw, ctx, kw_stats)
                    else:
                        collect_from_bloggers(page, kw, selected, ctx, kw_stats)
                else:
                    collect_from_hashtag(page, kw, ctx, kw_stats)
                print('关键词 #' + kw + ' 小结：采集帖子 ' + str(kw_stats['postsCollected']) +
                      ' 条，跳过旧帖 ' + str(kw_stats['postsSkippedOld']) +
                      ' 条；评论共看到 ' + str(kw_stats['commentsSeen']) + ' 条，意向保留 ' +
                      str(kw_stats['commentsKeptIntent']) + ' 条' +
                      ('；博主评估 ' + str(kw_stats['bloggersEvaluated']) + ' 个，选中 ' +
                       str(kw_stats['bloggersSelected']) + ' 个' if args['bloggerMode'] else '') + '。')
            return finish(0)
    except StopRun as stop:
        return finish(stop.exit_code)
    finally:
        if context is not None:
            try:
                context.close()
            except Exception:
                pass
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass


def run(argv):
    args = parse_args(argv)
    if args['checkCookies']:
        return run_check_cookies(args)
    if args['help'] or not args['keyword']:
        print_usage()
        return 0
    if args['browser'] and not browser_bits.is_valid_browser_choice(args['browser']):
        print('错误：--browser 只能是 chrome / msedge / chromium（或用环境变量 '
              'IG_COLLECTOR_BROWSER），你给的是：' + args['browser'])
        return 1
    return run_collect(args)


if __name__ == '__main__':
    try:
        sys.exit(run(sys.argv[1:]) or 0)
    except StopRun as stop:  # 兜底：正常路径里 StopRun 都在 run_collect 内收尾
        sys.exit(stop.exit_code or 0)
    except Exception as e:  # 与 JS 版同口径：顶层兜底只报一行
        print('运行出错：' + str(e))
        sys.exit(1)
