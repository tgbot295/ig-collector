# -*- coding: utf-8 -*-
"""纯模块测试（纯本地、虚构数据）：不需要 playwright、不碰浏览器、
不碰 IG、不读任何真实账号文件。

覆盖：cookies_parse（全格式 + 卖家整行 + 编码层 + 体检）、login_guard
（分类器/停止页/黑名单）、intent（四分类）、filters（商家信号/新鲜度）、
bloggers（粉丝解析/meta/选博主）、leads_out（两列 CSV）、
extract 的纯函数（文案行剔除 FIX A、链接/计数/节点解析、评论行清洗）。

跑法：py tests/run_tests.py
"""
import base64
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

import bloggers  # noqa: E402
import cookies_parse  # noqa: E402
import extract  # noqa: E402
import filters  # noqa: E402
import intent as intent_mod  # noqa: E402
import leads_out  # noqa: E402
import login_guard  # noqa: E402

passed = 0


def ok(name, fn):
    global passed
    fn()
    passed += 1
    print('PASS ' + name)


def b64_of(obj):
    return base64.b64encode(json.dumps(obj).encode('utf-8')).decode('ascii')


COOKIE_ARRAY = [
    {'name': 'sessionid', 'value': 'FAKE%3A123', 'domain': '.instagram.com',
     'path': '/', 'expirationDate': 1893456000, 'httpOnly': True, 'secure': True,
     'sameSite': 'no_restriction'},
    {'name': 'csrftoken', 'value': 'FAKECSRF', 'domain': '.instagram.com',
     'path': '/', 'expirationDate': 1893456000, 'secure': True, 'sameSite': 'lax'},
    {'name': 'rur', 'value': 'FAKERUR', 'domain': '.instagram.com', 'session': True,
     'expirationDate': 1893456000},
]

# ---------- cookies_parse：JSON 家族 ----------


def t_json_array():
    r = cookies_parse.analyze_text(json.dumps(COOKIE_ARRAY))
    assert r['error'] is None and r['format'] == 'json-array'
    assert r['hasSessionid'] is True
    names = [c['name'] for c in r['storageState']['cookies']]
    assert 'sessionid' in names and 'csrftoken' in names
    by_name = {c['name']: c for c in r['storageState']['cookies']}
    assert by_name['sessionid']['domain'] == '.instagram.com'
    assert by_name['sessionid']['expires'] == 1893456000  # expirationDate 映射
    assert by_name['sessionid']['sameSite'] == 'None'     # no_restriction → None
    assert by_name['csrftoken']['sameSite'] == 'Lax'
    assert by_name['rur']['expires'] == -1                # session:true 强制 -1
    pw = cookies_parse.to_playwright_cookies(r['storageState'])
    assert all(set(c) <= {'name', 'value', 'domain', 'path', 'expires',
                          'httpOnly', 'secure', 'sameSite'} for c in pw)
ok('cookies: JSON 数组 + expirationDate/sameSite/session 映射', t_json_array)


def t_json_object_and_dict():
    r = cookies_parse.analyze_text(json.dumps({'cookies': COOKIE_ARRAY, 'origins': []}))
    assert r['format'] == 'json-object' and r['hasSessionid']
    r2 = cookies_parse.analyze_text(json.dumps(
        {'sessionid': 'FAKE%3A9', 'csrftoken': 'FAKEC', 'ds_user_id': '42'}))
    assert r2['format'] == 'json-dict' and r2['hasSessionid']
    by_name = {c['name']: c for c in r2['storageState']['cookies']}
    assert by_name['sessionid']['value'] == 'FAKE%3A9'  # 值逐字节透传
    assert by_name['sessionid']['expires'] == -1       # 没写到期 = 会话 cookie
    assert 'sameSite' not in by_name['sessionid']      # 无法对应时省略字段
ok('cookies: {cookies:[...]} 对象与扁平字典', t_json_object_and_dict)


def t_label_line_and_missing():
    text = '卖家导出文件 第一行是标签\n' + json.dumps(COOKIE_ARRAY)
    r = cookies_parse.analyze_text(text)
    assert r['hasSessionid'] and r['format'] == 'json-array'
    r2 = cookies_parse.analyze_text(json.dumps([{'name': 'csrftoken', 'value': 'x'}]))
    assert r2['hasSessionid'] is False and r2['storageState'] is None
    assert r2['error'].code == 'missing_sessionid'
    assert 'sessionid' in str(r2['error'])  # 报错只点名，不带值
    r3 = cookies_parse.analyze_text('   ')
    assert r3['error'].code == 'empty'
    # 非 IG 域名的 cookie 被丢弃
    r4 = cookies_parse.analyze_text(json.dumps(
        [{'name': 'sessionid', 'value': 'v', 'domain': '.example.com'}]))
    assert r4['hasSessionid'] is False
ok('cookies: 标签行剥离 / 缺 sessionid / 空文件 / 异域名丢弃', t_label_line_and_missing)


# ---------- cookies_parse：Base64 包装与卖家整行 ----------


def t_base64_wrapped():
    raw = b64_of(COOKIE_ARRAY)
    wrapped = '\n'.join(raw[i:i + 64] for i in range(0, len(raw), 64))
    r = cookies_parse.analyze_text(wrapped)
    assert r['format'] == 'base64' and r['hasSessionid']
    # base64url 变体
    url_raw = base64.urlsafe_b64encode(
        json.dumps(COOKIE_ARRAY).encode('utf-8')).decode('ascii')
    r2 = cookies_parse.analyze_text(url_raw)
    assert r2['format'] == 'base64' and r2['hasSessionid']
    # 标签行 + Base64
    r3 = cookies_parse.analyze_text('HEADER LINE\n' + raw)
    assert r3['format'] == 'base64' and r3['hasSessionid']
ok('cookies: Base64 包装（64 字符折行 / base64url / 标签行）', t_base64_wrapped)


def t_seller_line():
    line = 'testuser99:FakePass123:testuser99@example.com:DHNK KILL:' + b64_of(COOKIE_ARRAY)
    r = cookies_parse.analyze_text(line)
    assert r['format'] == 'base64' and r['hasSessionid']
    assert r['detectedUsername'] == 'testuser99'
    blob = repr(r)
    assert 'FakePass123' not in blob and 'testuser99@example.com' not in blob
    # 密码里带冒号也行：只有真正的 Base64 尾巴能过形状检查
    line2 = 'user2:p:a:ss:u2@mail.example.com:M:' + b64_of(COOKIE_ARRAY)
    r2 = cookies_parse.analyze_text(line2)
    assert r2['hasSessionid'] and r2['detectedUsername'] == 'user2'
    assert 'p:a:ss' not in repr(r2)
    # 只有尾巴（最后一个标记词 + Base64）
    r3 = cookies_parse.analyze_text('PCBM:' + b64_of(COOKIE_ARRAY))
    assert r3['hasSessionid'] and r3['detectedUsername'] is None
ok('cookies: 卖家整行（用户名检出，密码/邮箱绝不外泄）', t_seller_line)


# ---------- cookies_parse：Netscape / Cookie 头 / 编码层 ----------

NETSCAPE_TEXT = (
    '# Netscape HTTP Cookie File\n'
    '.instagram.com\tTRUE\t/\tTRUE\t1893456000\tcsrftoken\tFAKECSRF\n'
    '#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tFAKE%3A777\n'
)


def t_netscape_and_header():
    r = cookies_parse.analyze_text(NETSCAPE_TEXT)
    assert r['format'] == 'netscape' and r['hasSessionid']
    by_name = {c['name']: c for c in r['storageState']['cookies']}
    assert by_name['sessionid']['httpOnly'] is True  # #HttpOnly_ 行
    assert by_name['sessionid']['expires'] == 1893456000
    r2 = cookies_parse.analyze_text(
        'sessionid=FAKE%3A5; csrftoken=FAKEC; ds_user_id=42')
    assert r2['format'] == 'cookie-header' and r2['hasSessionid']
    r3 = cookies_parse.analyze_text('Cookie: sessionid=ONLYONE')
    assert r3['format'] == 'cookie-header' and r3['hasSessionid']
    r4 = cookies_parse.analyze_text('justone=abc')
    assert r4['storageState'] is None  # 只有 1 对且不是 sessionid → 不认
ok('cookies: Netscape（含 #HttpOnly_）与 Cookie 头', t_netscape_and_header)


def t_encodings():
    payload = json.dumps(COOKIE_ARRAY)
    utf16 = b'\xff\xfe' + payload.encode('utf-16-le')
    r = cookies_parse.analyze_session_buffer(utf16)
    assert r['hasSessionid'] and r['encoding'] == 'utf16le'
    utf16be = b'\xfe\xff' + payload.encode('utf-16-be')
    r2 = cookies_parse.analyze_session_buffer(utf16be)
    assert r2['hasSessionid'] and r2['encoding'] == 'utf16be'
    bom = b'\xef\xbb\xbf' + payload.encode('utf-8')
    r3 = cookies_parse.analyze_session_buffer(bom)
    assert r3['hasSessionid'] and r3['encoding'] == 'utf8-bom'
    # 无 BOM 的 UTF-16LE 靠 NUL 分布猜
    r4 = cookies_parse.analyze_session_buffer(payload.encode('utf-16-le'))
    assert r4['hasSessionid'] and r4['encoding'] == 'utf16le-guess'
ok('cookies: UTF-16LE/BE（带 BOM 与无 BOM 猜测）+ UTF-8 BOM', t_encodings)


def t_diagnose_and_candidates():
    with tempfile.TemporaryDirectory() as d:
        good = os.path.join(d, 'b-good.txt')
        with open(good, 'w', encoding='utf-8') as f:
            f.write(json.dumps(COOKIE_ARRAY))
        bad = os.path.join(d, 'a-nosid.txt')
        with open(bad, 'w', encoding='utf-8') as f:
            f.write(json.dumps([{'name': 'csrftoken', 'value': 'x'}]))
        empty = os.path.join(d, 'c-empty.txt')
        open(empty, 'w').close()
        ns = os.path.join(d, 'd-netscape.txt')
        with open(ns, 'w', encoding='utf-8') as f:
            f.write('# Netscape\n.instagram.com\tTRUE\t/\tTRUE\t1893456000\tfoo\tbar\n')
        d1 = cookies_parse.diagnose_file(good)
        assert d1['ok'] and d1['format'] == 'json数组' and d1['hasSessionid']
        d2 = cookies_parse.diagnose_file(bad)
        assert not d2['ok'] and d2['reason'] == '没有sessionid'
        d3 = cookies_parse.diagnose_file(empty)
        assert not d3['ok'] and d3['reason'] == '空文件'
        d4 = cookies_parse.diagnose_file(ns)
        assert not d4['ok'] and d4['reason'] == '像Netscape格式但没有sessionid'
        scan = cookies_parse.load_candidates(d)
        assert [c['file'] for c in scan['parseable']] == ['b-good.txt']
        reasons = {u['file']: u['reason'] for u in scan['unparseable']}
        assert reasons['a-nosid.txt'] == '没有sessionid'
        assert reasons['c-empty.txt'] == '空文件'
ok('cookies: 体检结论与文件夹候选扫描', t_diagnose_and_candidates)


# ---------- login_guard ----------


def t_guard_classifier():
    c = login_guard.classify_login_signals
    assert c({'hasCheckpointSignal': True}, 1)['verdict'] == 'checkpoint'
    assert c({'url': 'https://www.instagram.com/auth_platform/'}, 1)['verdict'] == 'checkpoint'
    assert c({'hasUsername': True}, 1)['verdict'] == 'logged_in'
    assert c({'hasProfileNavSignal': True}, 1)['verdict'] == 'logged_in'
    base = {'url': 'https://www.instagram.com/', 'hasSessionidCookie': True,
            'hasVisiblePasswordInput': False, 'urlIsLogin': False}
    assert c(base, 1)['verdict'] == 'logged_in'
    # onetap“保存登录信息”页不是登录墙：URL 是 onetap、有 sessionid、无密码框
    onetap = {'url': 'https://www.instagram.com/accounts/onetap/',
              'hasSessionidCookie': True, 'hasVisiblePasswordInput': False}
    assert c(onetap, 1)['verdict'] == 'logged_in'
    wall = {'url': 'https://www.instagram.com/accounts/login/',
            'hasSessionidCookie': True, 'hasVisiblePasswordInput': True}
    assert c(wall, 1)['verdict'] == 'retry'
    assert c(wall, 2)['verdict'] == 'session_expired'
    soft = {'url': 'https://www.instagram.com/', 'hasLoginForm': True,
            'hasSessionidCookie': False, 'hasVisiblePasswordInput': False}
    assert c(soft, 2)['verdict'] == 'not_confirmed'
    assert c({}, 1)['verdict'] == 'retry'
    assert c({}, 2)['verdict'] == 'not_confirmed'
ok('guard: 登录核验分类器（准绳三条/onetap 非墙/两轮判失效）', t_guard_classifier)


def t_guard_stop_and_blocklist():
    d = login_guard.detect_stop_page
    assert d({'url': 'https://www.instagram.com/challenge/123/', 'text': ''})['reason'] == 'checkpoint'
    assert d({'url': 'https://www.instagram.com/', 'text': 'Please wait a few minutes'})['reason'] == 'rate_limit'
    assert d({'url': 'https://www.instagram.com/accounts/login/', 'text': ''})['reason'] == 'login_wall'
    assert d({'url': 'https://www.instagram.com/', 'text': '普通页面内容'}) is None
    assert login_guard.is_blocked_username('@NatalieM.Jordan') is True
    assert login_guard.is_blocked_username('mm8989221') is True
    assert login_guard.is_blocked_username('some_seller_01') is False
    assert login_guard.is_blocked_username('') is False
    assert login_guard.is_blocked_username(None) is False
ok('guard: 停止页检测与主号黑名单', t_guard_stop_and_blocklist)


# ---------- intent ----------


def t_intent():
    f = intent_mod.classify_comment
    assert f('How much is this?') == ['问价格']
    assert f('how to buy this bag?') == ['问购买']
    assert f('do you ship to Canada?') == ['问运费']
    assert f('what size is available?') == ['问尺码']
    assert f('多少钱？') == ['问价格']
    assert f('怎么买啊') == ['问购买']
    assert f('包邮吗，发货快吗') == ['问运费']
    assert f('Nice photo!') == []
    # 类别顺序固定：问购买在问价格之前
    assert f('how much and how to buy') == ['问购买', '问价格']
    kept = intent_mod.filter_comments_by_intent(
        [{'text': 'price?'}, {'text': 'hello'}], False)
    assert kept['seen'] == 2 and kept['intentCount'] == 1 and len(kept['kept']) == 1
    assert kept['kept'][0]['intentTypes'] == ['问价格']
    allk = intent_mod.filter_comments_by_intent(
        [{'text': 'price?'}, {'text': 'hello'}], True)
    assert len(allk['kept']) == 2 and allk['kept'][1]['intentTypes'] == []
ok('intent: 意向四分类（中英双语/多命中/预筛）', t_intent)


# ---------- filters ----------


def t_filters():
    sig = filters.merchant_signals_of
    assert '文案含 DM to buy/order' in sig('DM to order, wholesale price $100')
    assert '文案含 商店' in sig('欢迎光临我的小商店')
    assert '文案含 店铺' in sig('本店铺新品')
    assert '文案含 WhatsApp' in sig('contact via WhatsApp')
    # 咖啡店/书店不误伤：单个“店”字不是信号
    assert sig('在这家咖啡店拍照打卡') == []
    assert sig('周末去书店看书') == []
    assert filters.is_merchant_caption('新款上架，私信下单') is True
    assert filters.is_merchant_caption('今天天气不错') is False

    now = datetime.now(timezone.utc)
    recent = (now - timedelta(days=10)).isoformat()
    old = (now - timedelta(days=400)).isoformat()
    base = {'now': now.isoformat(), 'maxAgeDays': 365}
    assert filters.decide_post_age({**base, 'timestamp': recent})['action'] == 'keep'
    assert filters.decide_post_age({**base, 'timestamp': old})['action'] == 'skip'
    assert filters.decide_post_age({**base, 'timestamp': None})['action'] == 'keep'
    assert filters.decide_post_age({**base, 'timestamp': '不是日期'})['action'] == 'keep'
    assert filters.decide_post_age({'now': now.isoformat(), 'maxAgeDays': 0,
                                    'timestamp': old})['action'] == 'keep'
    edge = (now - timedelta(days=365)).isoformat()
    assert filters.decide_post_age({**base, 'timestamp': edge})['action'] == 'keep'
ok('filters: 商家信号（咖啡店不误伤）与帖子新鲜度', t_filters)


# ---------- bloggers ----------


def t_blogger_parse():
    p = bloggers.parse_follower_count
    assert p('1,234') == 1234
    assert p('1,234,567') == 1234567
    assert p('987') == 987
    assert p(1234) == 1234
    assert p('12.3K') == 12300
    assert p('12.3k') == 12300
    assert p('1.2M') == 1200000
    assert p('1.5B') == 1500000000
    assert p('12.3K followers') == 12300
    assert p('3.5万') == 35000
    assert p('37.2万粉丝') == 372000
    assert p('1.2亿') == 120000000
    assert p('abc') is None
    assert p('') is None
    assert p(None) is None
    assert bloggers.format_followers(372000) == '37.2万'
    assert bloggers.format_followers(10000) == '1万'
    assert bloggers.format_followers(1234) == '1,234'
    assert bloggers.format_followers(None) == '未知'
    assert bloggers.format_followers_full(123456) == '123,456'
    assert bloggers.format_followers_full(None) == '未知'
ok('bloggers: 粉丝数解析与显示', t_blogger_parse)


def t_blogger_meta():
    m = bloggers.parse_followers_from_meta
    assert m('12,345 Followers, 56 Following, 789 Posts - See Instagram photos '
             'and videos from Some Shop (@some_shop)') == 12345
    assert m('1.2M Followers, 10 Following, 5 Posts - x') == 1200000
    assert m('37.2万粉丝，关注 12，帖子 34') == 372000
    assert m('See Instagram photos and videos from X') is None
    assert m('') is None
    assert m(None) is None
    bio = bloggers.parse_bio_from_meta(
        '1,234 Followers, 5 Following, 6 Posts - Bags shop, DM to order')
    assert bio == 'Bags shop, DM to order'
    assert bloggers.parse_bio_from_meta('no counts here') is None
ok('bloggers: meta description 粉丝解析（第一优先来源）', t_blogger_meta)


def t_blogger_select():
    ev = bloggers.evaluate_profile_candidate
    biz = ev({'username': 'shop_a', 'followers': 50000, 'isBusiness': True,
              'bio': 'welcome'})
    assert biz['merchant'] is True and biz['followers'] == 50000
    bio_hit = ev({'username': 'shop_b', 'followers': '37.2万', 'isBusiness': None,
                  'bio': 'bags, WhatsApp me', 'captions': []})
    assert bio_hit['merchant'] is True and bio_hit['followers'] == 372000
    cap_hit = ev({'username': 'shop_c', 'followers': 20000, 'bio': '',
                  'captions': ['new bag, DM to order']})
    assert cap_hit['merchant'] is True
    plain = ev({'username': 'user_d', 'followers': 999999, 'bio': 'love travel'})
    assert plain['merchant'] is False

    cands = [
        {'username': 'low', 'followers': 9999, 'merchant': True},
        {'username': 'unknown', 'followers': None, 'merchant': True},
        {'username': 'notshop', 'followers': 500000, 'merchant': False},
        {'username': 'big', 'followers': 300000, 'merchant': True},
        {'username': 'mid', 'followers': 50000, 'merchant': True},
        {'username': 'tie1', 'followers': 50000, 'merchant': True},
    ]
    sel = bloggers.select_bloggers(cands, {'minFollowers': 10000, 'topN': 2})
    assert [c['username'] for c in sel] == ['big', 'mid']  # 降序 + topN + 同分稳定
    sel_all = bloggers.select_bloggers(cands, {'minFollowers': 10000, 'topN': 10})
    assert [c['username'] for c in sel_all] == ['big', 'mid', 'tie1']
    edge = bloggers.select_bloggers(
        [{'username': 'edge', 'followers': 10000, 'merchant': True}],
        {'minFollowers': 10000, 'topN': 5})
    assert len(edge) == 1  # 门槛是 >=：正好达标入选
ok('bloggers: 候选评估与选博主规则（商家+已知粉丝+门槛）', t_blogger_select)


# ---------- leads_out ----------


def _lead_items():
    return [
        {'ownerUsername': 'shop_a', 'keyword': 'downjacket', 'latestComments': [
            {'ownerUsername': 'buyer1', 'text': 'How much?', 'intentTypes': ['问价格']},
            {'ownerUsername': 'shop_a', 'text': 'DM to order', 'intentTypes': ['问购买']},
            {'ownerUsername': 'buyer2', 'text': 'nice one', 'intentTypes': []},
            {'ownerUsername': 'buyer1', 'text': 'How much?', 'intentTypes': ['问价格']},
            {'ownerUsername': '', 'text': 'price?', 'intentTypes': ['问价格']},
            {'ownerUsername': 'buyer3', 'text': '   ', 'intentTypes': ['问价格']},
        ]},
        {'ownerUsername': 'shop_b', 'keyword': 'handbag', 'latestComments': [
            {'ownerUsername': 'buyer1', 'text': 'How much?', 'intentTypes': ['问价格']},
            {'ownerUsername': 'buyer4', 'text': 'ship to Canada?',
             'intentTypes': ['问运费']},
        ]},
        {'ownerUsername': 'lonely', 'text': 'not a post item'},
    ]


def t_leads():
    rows = leads_out.build_leads_rows(_lead_items())
    # 意向限定、帖主自评剔除、跨帖去重、空用户名/空评论跳过、首次顺序
    assert rows == [
        {'profileUrl': 'https://www.instagram.com/buyer1/', 'comment': 'How much?'},
        {'profileUrl': 'https://www.instagram.com/buyer4/', 'comment': 'ship to Canada?'},
    ]
    csv_text = leads_out.to_csv(rows)
    assert csv_text.startswith('\ufeff用户链接,评论内容\r\n')
    assert csv_text.endswith('\r\n')
    tricky = leads_out.to_csv([
        {'profileUrl': 'https://www.instagram.com/x/', 'comment': 'a,b "q"\nline2'}])
    assert '"a,b ""q""\nline2"' in tricky
    entries = leads_out.build_leads_entries_all(_lead_items())
    kw = {(e['username'], e['comment']): e['keyword'] for e in entries}
    assert kw[('buyer4', 'ship to Canada?')] == 'handbag'
ok('leads_out: 两列名单（意向限定/自评剔除/去重/BOM+引号转义）', t_leads)


# ---------- extract 纯函数 ----------


def t_extract_pure():
    assert extract.shortcode_from_url('https://www.instagram.com/p/ABC123_-x/') == 'ABC123_-x'
    assert extract.shortcode_from_url('https://www.instagram.com/reel/ZZ9/') == 'ZZ9'
    links = extract.extract_post_links_from_hrefs([
        '/p/AAA/', 'https://www.instagram.com/p/AAA/?utm=1', '/reel/BBB/',
        '/explore/tags/x/', None, ''])
    assert [l['shortCode'] for l in links] == ['AAA', 'BBB']
    assert links[0]['url'] == 'https://www.instagram.com/p/AAA/'
    assert links[1]['url'] == 'https://www.instagram.com/reel/BBB/'
    assert extract.parse_count('1.5k') == 1500
    assert extract.parse_count('321') == 321
    assert extract.parse_count('abc') is None
    og = extract.parse_og_counts('321 likes, 45 comments - caption')
    assert og == {'likesCount': 321, 'commentsCount': 45}
    assert extract.to_iso(1700000000).startswith('2023-')
    assert extract.to_iso('not a date') is None
    assert extract.username_from_profile_href('/some.user/') == 'some.user'
    assert extract.username_from_profile_href('/p/ABC/') is None
    assert extract.is_ui_only_text('Reply') is True
    assert extract.is_ui_only_text('3h') is True
    assert extract.is_ui_only_text('How much is it?') is False
ok('extract: 链接/计数/og/用户名等纯函数', t_extract_pure)


def t_extract_media_node():
    payload = {'data': {'xdt_shortcode_media': {
        'shortcode': 'CODE1', '__typename': 'GraphImage',
        'owner': {'username': 'shop_x', 'full_name': 'Shop X'},
        'edge_media_to_caption': {'edges': [{'node': {'text': 'New bag $99 #bags'}}]},
        'edge_media_preview_like': {'count': 321},
        'edge_media_to_parent_comment': {'count': 45, 'edges': [
            {'node': {'id': '1', 'text': 'How much?',
                      'owner': {'username': 'buyer9'}, 'created_at': 1700000000}}]},
        'taken_at_timestamp': 1700000000,
        'display_url': 'https://example.com/img.jpg',
    }}}
    r = extract.extract_post_from_payload(payload, 'https://www.instagram.com/p/CODE1/')
    assert r is not None
    post = r['post']
    assert post['ownerUsername'] == 'shop_x'
    assert post['caption'] == 'New bag $99 #bags'
    assert post['hashtags'] == ['bags']
    assert post['likesCount'] == 321
    assert post['commentsCount'] == 45  # 页面自报评论数（FIX C 的 stated）
    assert post['timestamp'] is not None
    assert len(r['comments']) == 1
    assert r['comments'][0]['ownerUsername'] == 'buyer9'
    txt = json.dumps(payload)
    r2 = extract.extract_post_from_text(txt, 'https://www.instagram.com/p/CODE1/')
    assert r2 is not None and r2['post']['shortCode'] == 'CODE1'
ok('extract: 内嵌 JSON 帖子节点解析（含自报评论数）', t_extract_media_node)


def t_extract_rows_and_caption_fix():
    rows = [
        {'username': 'shop_x', 'segments': ['shop_x', 'New bag $99 #bags'],
         'datetime': '2026-01-01T00:00:00.000Z'},
        {'username': 'buyer9', 'segments': ['buyer9', 'How much?', 'Reply'],
         'datetime': '2026-01-02T00:00:00.000Z'},
        {'username': 'buyer9', 'segments': ['buyer9', 'How much?'],
         'datetime': '2026-01-02T00:00:00.000Z'},
    ]
    comments = extract.rows_to_comments(rows, 'https://www.instagram.com/p/C/', 50)
    assert len(comments) == 2  # 重复行去重
    # FIX A：文案行（帖主 + 正文==文案）被剔除；帖主的真实评论保留；
    # 别人引用文案原文不算文案行（用户名不同）。
    fixed = extract.filter_comment_rows(comments, 'shop_x', 'New bag $99 #bags')
    assert len(fixed) == 1 and fixed[0]['ownerUsername'] == 'buyer9'
    self_reply = [{'ownerUsername': 'shop_x', 'text': 'size 40 in stock'},
                  {'ownerUsername': 'shop_x', 'text': 'New bag $99 #bags'}]
    fixed2 = extract.filter_comment_rows(self_reply, 'shop_x', 'New bag $99 #bags')
    assert len(fixed2) == 1 and fixed2[0]['text'] == 'size 40 in stock'
    ws = [{'ownerUsername': 'shop_x', 'text': 'New bag\n$99   #bags'}]
    assert extract.filter_comment_rows(ws, 'shop_x', 'New bag $99 #bags') == []
    assert extract.filter_comment_rows(self_reply, 'shop_x', '') == self_reply
    snap = {'headerUsernames': ['shop_x'], 'rows': rows, 'postDatetime': None,
            'counts': {'anchorsTotal': 10, 'profileAnchors': 3,
                       'commentRowCandidates': 3},
            'hasCommentsContainer': True, 'navProfileUsername': None}
    ana = extract.analyze_snapshot(snap, 'https://www.instagram.com/p/C/', 50)
    assert ana['headerOwner'] == 'shop_x'
    assert ana['captionAuthor'] == 'shop_x'
    assert ana['captionText'] == 'New bag $99 #bags'
    owner = extract.pick_owner_username(
        {'headerOwner': ana['headerOwner'], 'payloadOwner': '', 'captionAuthor': 'zzz'})
    assert owner == 'shop_x'
    assert extract.needs_post_debug({'ownerUsername': ''}, []) is True
    assert extract.needs_post_debug({'ownerUsername': 'a'}, []) is False
ok('extract: 快照分析与文案行剔除（FIX A）', t_extract_rows_and_caption_fix)


def main():
    print('纯模块测试全部通过：%d 组' % passed)
    return 0


if __name__ == '__main__':
    sys.exit(main())
