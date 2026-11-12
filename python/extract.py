# -*- coding: utf-8 -*-
"""提取模块：从链接列表、页面文本/JSON 数据里提取帖子与评论（纯函数部分），
以及页面内执行的 JS 片段和 Playwright 包装（harvest_post 等）。

移植自 JS 版 src/extract.js + src/extractDom.js，并带上三处实地修复：
- FIX A（文案冒充评论）：filter_comment_rows —— 评论行里
  username == 帖主 且 正文 == 文案（空白归一后）的那行是文案行，
  不是评论，剔除。以前每条帖子恒“评论共 1 条、意向 0 条”就是它。
- FIX B（展开+定向滚动）：collect_post_comments 先点“查看全部评论/
  Load more comments”等展开控件（最多 3 次，滚动轮次间也会补点），
  滚动时优先滚【文案行的可滚动祖先】（页面内 findCommentsContainer
  第 0 步），找不到才整页滚。
原则：拿不到的字段一律给 None / 空，绝不编造数字。

本模块的纯函数部分不 import playwright；带 page 参数的包装函数只用
传入的 page 对象（鸭子类型），导入本模块本身不需要 playwright。
"""
import json
import math
import re
import time
from datetime import datetime, timezone

# ================= 纯函数：链接与计数 =================


def extract_hashtags(caption):
    if not caption:
        return []
    return [m.group(1) for m in re.finditer(r'#([\w]+)', str(caption), re.UNICODE)]


def shortcode_from_url(url):
    if not url:
        return None
    m = re.search(r'/(?:p|reel|reels)/([A-Za-z0-9_-]+)', str(url))
    return m.group(1) if m else None


def extract_post_links_from_hrefs(hrefs):
    """从 href 列表里挑帖子/Reel 链接，按 shortcode 去重。"""
    seen = {}
    for href in hrefs or []:
        code = shortcode_from_url(href)
        if not code or code in seen:
            continue
        is_reel = bool(re.search(r'/(reel|reels)/', str(href)))
        seen[code] = {
            'shortCode': code,
            'url': 'https://www.instagram.com/' + ('reel' if is_reel else 'p') + '/' + code + '/',
        }
    return list(seen.values())


def parse_count(v):
    """"1,234" / "1.5k" / "2.3m" -> 数字；认不出返回 None。"""
    if v is None or v == '':
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v if math.isfinite(v) else None
    s = str(v).strip().lower().replace(',', '')
    m = re.search(r'([\d.]+)\s*([km])?', s)
    if not m:
        return None
    try:
        n = float(m.group(1))
    except ValueError:
        return None
    if not math.isfinite(n):
        return None
    if m.group(2) == 'k':
        n *= 1e3
    if m.group(2) == 'm':
        n *= 1e6
    return int(round(n))


def parse_og_counts(og):
    """og:description 形如 "321 likes, 45 comments - ..." 时抠计数。"""
    out = {'likesCount': None, 'commentsCount': None}
    if not og:
        return out
    like = re.search(r'([\d,.]+[km]?)\s+likes?', str(og), re.I)
    com = re.search(r'([\d,.]+[km]?)\s+comments?', str(og), re.I)
    if like:
        out['likesCount'] = parse_count(like.group(1))
    if com:
        out['commentsCount'] = parse_count(com.group(1))
    return out


def _format_iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (dt.microsecond // 1000)


def to_iso(v):
    if v is None or v == '':
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if not math.isfinite(v):
            return None
        ms = v if v > 1e12 else v * 1000
        try:
            return _format_iso(datetime.fromtimestamp(ms / 1000, tz=timezone.utc))
        except (OverflowError, OSError, ValueError):
            return None
    s = str(v).strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace('Z', '+00:00').replace('z', '+00:00'))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return _format_iso(dt.astimezone(timezone.utc))


def normalize_comment(raw=None):
    """统一评论形状（与主工具导入模块的输入字段对齐）。"""
    raw = raw or {}
    likes = raw.get('likesCount')
    return {
        'id': str(raw['id']) if raw.get('id') is not None else None,
        'text': raw.get('text') or '',
        'ownerUsername': raw.get('ownerUsername') or '',
        'ownerProfilePicUrl': raw.get('ownerProfilePicUrl') or '',
        'likesCount': likes if isinstance(likes, (int, float)) and not isinstance(likes, bool)
        else parse_count(likes),
        'timestamp': raw.get('timestamp'),
        'postUrl': raw.get('postUrl') or '',
    }


# ================= 纯函数：内嵌 JSON 帖子节点 =================


def find_media_node(root):
    """在任意嵌套对象里 BFS 找帖子节点（带 shortcode/code + owner/user 的对象）。"""
    if not isinstance(root, (dict, list)):
        return None
    queue = [root]
    seen = set()
    steps = 0
    while queue and steps < 8000:
        steps += 1
        cur = queue.pop(0)
        if not isinstance(cur, (dict, list)) or id(cur) in seen:
            continue
        seen.add(id(cur))
        if isinstance(cur, dict):
            has_code = isinstance(cur.get('shortcode'), str) or isinstance(cur.get('code'), str)
            has_owner = isinstance(cur.get('owner'), dict) or isinstance(cur.get('user'), dict)
            has_body = ('edge_media_to_caption' in cur or 'caption' in cur
                        or 'edge_media_preview_like' in cur or 'like_count' in cur
                        or 'edge_media_to_parent_comment' in cur)
            if has_code and has_owner and has_body:
                return cur
            children = list(cur.values())
        else:
            children = list(cur)
        for v in children:
            if isinstance(v, (dict, list)):
                queue.append(v)
    return None


def media_node_to_result(node, post_url=None):
    """把 IG 帖子节点（GraphQL shortcode_media / items 两种常见形状）
    转成导入兼容形状。"""
    if not isinstance(node, dict):
        return None
    short_code = node.get('shortcode') or node.get('code')
    owner_obj = node.get('owner') or node.get('user') or {}
    if not isinstance(owner_obj, dict):
        owner_obj = {}
    owner_username = owner_obj.get('username') or ''
    if not short_code and not owner_username:
        return None

    caption = ''
    cap_edges = (node.get('edge_media_to_caption') or {}).get('edges') \
        if isinstance(node.get('edge_media_to_caption'), dict) else None
    if isinstance(cap_edges, list) and cap_edges and isinstance(cap_edges[0], dict) \
            and isinstance(cap_edges[0].get('node'), dict):
        caption = cap_edges[0]['node'].get('text') or ''
    if not caption and isinstance(node.get('caption'), dict):
        caption = node['caption'].get('text') or ''
    if not caption and isinstance(node.get('caption'), str):
        caption = node['caption']

    likes_raw = (node.get('edge_media_preview_like') or {}).get('count') \
        if isinstance(node.get('edge_media_preview_like'), dict) else node.get('like_count')
    if isinstance(node.get('edge_media_to_parent_comment'), dict):
        comments_raw = node['edge_media_to_parent_comment'].get('count')
    elif isinstance(node.get('edge_media_to_comment'), dict):
        comments_raw = node['edge_media_to_comment'].get('count')
    else:
        comments_raw = node.get('comment_count')
    ts_raw = node.get('taken_at_timestamp') if node.get('taken_at_timestamp') is not None \
        else node.get('taken_at')
    url = post_url or ('https://www.instagram.com/p/' + short_code + '/' if short_code else None)

    display_url = node.get('display_url') or ''
    if not display_url:
        iv2 = node.get('image_versions2')
        if isinstance(iv2, dict) and isinstance(iv2.get('candidates'), list) \
                and iv2['candidates'] and isinstance(iv2['candidates'][0], dict):
            display_url = iv2['candidates'][0].get('url') or ''

    post = {
        'id': str(node['id']) if node.get('id') is not None
        else (str(node['pk']) if node.get('pk') is not None else None),
        'shortCode': short_code,
        'type': 'Video' if node.get('is_video') else 'Image',
        'caption': caption,
        'hashtags': extract_hashtags(caption),
        'mentions': [],
        'url': url,
        'likesCount': likes_raw if isinstance(likes_raw, (int, float)) and not isinstance(likes_raw, bool)
        else parse_count(likes_raw),
        'commentsCount': comments_raw if isinstance(comments_raw, (int, float))
        and not isinstance(comments_raw, bool) else parse_count(comments_raw),
        'timestamp': to_iso(ts_raw),
        'displayUrl': display_url,
        'videoUrl': node.get('video_url') or '',
        'ownerUsername': owner_username,
        'ownerFullName': owner_obj.get('full_name') or '',
    }

    comments = []
    c_edges = None
    if isinstance(node.get('edge_media_to_parent_comment'), dict):
        c_edges = node['edge_media_to_parent_comment'].get('edges')
    if c_edges is None and isinstance(node.get('edge_media_to_comment'), dict):
        c_edges = node['edge_media_to_comment'].get('edges')
    if isinstance(c_edges, list):
        for e in c_edges:
            n = e.get('node') if isinstance(e, dict) else None
            if not isinstance(n, dict):
                continue
            comments.append(normalize_comment({
                'id': n.get('id'),
                'text': n.get('text'),
                'ownerUsername': (n.get('owner') or {}).get('username')
                if isinstance(n.get('owner'), dict) else None,
                'timestamp': to_iso(n.get('created_at')),
                'postUrl': url,
                'likesCount': (n.get('edge_liked_by') or {}).get('count')
                if isinstance(n.get('edge_liked_by'), dict) else None,
            }))
    if isinstance(node.get('comments'), list):
        for c in node['comments']:
            if not isinstance(c, dict):
                continue
            comments.append(normalize_comment({
                'id': c.get('id') or c.get('pk'),
                'text': c.get('text'),
                'ownerUsername': (c.get('user') or {}).get('username')
                if isinstance(c.get('user'), dict) else None,
                'timestamp': to_iso(c.get('created_at')),
                'postUrl': url,
                'likesCount': c.get('like_count'),
            }))
    return {'post': post,
            'comments': [c for c in comments if c['text'] or c['ownerUsername']]}


def extract_post_from_payload(payload, post_url=None):
    node = find_media_node(payload)
    return media_node_to_result(node, post_url) if node else None


def extract_balanced_json(text, from_idx):
    """从 text 里某位置开始抠出一个花括号平衡的 JSON 对象（跳过字符串内部）。"""
    start = text.find('{', from_idx)
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == '\\':
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def extract_post_from_text(text, post_url=None):
    """从整页文本（HTML 里嵌的 JSON 等）里提取帖子：先整段 JSON 解析，
    再按关键 key 定位，最后试反转义兜底。"""
    if not text:
        return None
    s = str(text)
    try:
        parsed = json.loads(s)
        r = extract_post_from_payload(parsed, post_url)
        if r:
            return r
    except Exception:
        pass  # 不是纯 JSON，继续按片段找

    for key in ('"shortcode_media"', '"xdt_shortcode_media"'):
        idx = s.find(key)
        if idx < 0:
            continue
        chunk = extract_balanced_json(s, idx)
        if not chunk:
            continue
        try:
            node = json.loads(chunk)
            r = media_node_to_result(node, post_url) or extract_post_from_payload(node, post_url)
            if r:
                return r
        except Exception:
            continue
    # 兜底：被转义过的 JSON（\"shortcode\"）先反转义再找一次
    if '\\"shortcode\\"' in s:
        unescaped = s.replace('\\"', '"').replace('\\\\', '\\')
        if unescaped != s:
            return extract_post_from_text(unescaped, post_url)
    return None


# ================= 纯函数：DOM 快照分析（extractDom.js 的 Node 侧） =================

RESERVED_SEGMENTS = {
    'p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'direct', 'tv',
    'about', 'legal', 'privacy', 'terms', 'help', 'session', 'challenge',
    'auth_platform', 'graphql', 'api', 'web', 'static', 'developer', 'blog',
}


def username_from_profile_href(href):
    """从 href 里抠 /<username>/ 形式的用户名；不是单段资料路径返回 None。"""
    if not href:
        return None
    m = re.match(r'^(?:[a-z]+://[^/?#]+)?(/[^?#]*)', str(href), re.I)
    p = m.group(1) if m else str(href)
    mm = re.fullmatch(r'/([A-Za-z0-9._]+)/?', p)
    if not mm:
        return None
    if mm.group(1).lower() in RESERVED_SEGMENTS:
        return None
    return mm.group(1)


_UI_ONLY_PATTERNS = [
    re.compile(r'(like|reply|view replies|hide replies|view more comments?|view all comments|see translation|edited|follow|following)', re.I),
    re.compile(r'(view|hide)(\s+all)?\s+\d*\s*replies', re.I),
    re.compile(r'\d+\s*(s|m|h|d|w)', re.I),
    re.compile(r'\d+\s*(秒|分钟|小时|天|周|个月|年)(前)?'),
    re.compile(r'(点赞|回复|查看回复|隐藏回复|查看全部评论|查看翻译|已编辑|关注|已关注)'),
    re.compile(r'查看(全部)?\s*\d*\s*条回复'),
    re.compile(r'\d[\d,.]*\s*[kKmM]?'),
    re.compile(r'\d[\d,.]*\s*(likes?|次点赞)', re.I),
    re.compile(r'\d{4}-\d{1,2}-\d{1,2}([ t]\d{1,2}:\d{2}(:\d{2})?)?'),
]


def is_ui_only_text(text):
    """纯 UI 文本（不是评论内容）：点赞/回复按钮、展开回复、时间、计数、日期等。"""
    t = re.sub(r'[·•]+$', '', str(text or '').strip()).strip()
    if not t:
        return True
    return any(p.fullmatch(t) for p in _UI_ONLY_PATTERNS)


def comment_text_from_segments(segments, username):
    """从一行评论的文本片段里挑真正的评论正文：去掉用户名本身、UI 片段、
    时间/计数片段，剩下的取最长一段。“用户名 正文”粘在一起的先剥用户名。"""
    uname = str(username or '')
    best = ''
    seen = set()
    for raw in segments or []:
        t = str(raw or '').strip()
        if not t or t in seen:
            continue
        seen.add(t)
        if uname:
            if t == uname or t == '@' + uname:
                continue
            if t.startswith(uname + ' '):
                t = t[len(uname) + 1:].strip()
            elif t.startswith('@' + uname + ' '):
                t = t[len(uname) + 2:].strip()
        if not t or is_ui_only_text(t):
            continue
        if len(t) > len(best):
            best = t
    return best


def rows_to_comments(rows, post_url='', cap=50):
    """快照行 -> 统一评论形状：无正文的行丢弃，按 用户名|正文 去重，
    保留页面顺序，按 cap 截断。作者本人的行（文案行/自回复）在这一层
    保留，文案行由 filter_comment_rows 剔除、自回复由下游处理。"""
    limit = cap if cap and cap > 0 else 50
    out = []
    seen = set()
    for row in rows or []:
        username = str((row or {}).get('username') or '').strip()
        if not username:
            continue
        text = comment_text_from_segments(row.get('segments'), username)
        if not text:
            continue
        key = username + '|' + text
        if key in seen:
            continue
        seen.add(key)
        dt = row.get('datetime')
        out.append(normalize_comment({
            'text': text,
            'ownerUsername': username,
            'timestamp': (to_iso(dt) or dt) if dt else None,
            'postUrl': post_url or '',
        }))
        if len(out) >= limit:
            break
    return out


def analyze_snapshot(snapshot, post_url='', cap=50):
    """一份快照的分析结果：页头作者、文案行作者与文案、洗好的评论、结构计数。"""
    snap = snapshot or {}
    rows = snap.get('rows') if isinstance(snap.get('rows'), list) else []
    header_usernames = snap.get('headerUsernames') if isinstance(snap.get('headerUsernames'), list) else []
    first = rows[0] if rows else None
    counts = snap.get('counts') or {}
    post_dt = snap.get('postDatetime')
    cap_dt = first.get('datetime') if first else None
    return {
        'headerOwner': header_usernames[0] if header_usernames else '',
        'captionAuthor': str(first.get('username') or '') if first else '',
        'captionText': comment_text_from_segments(first.get('segments'), first.get('username'))
        if first else '',
        # 发布时间候选：postDatetime = 评论行之外的帖子日期；captionDatetime
        # = 文案行（第一行）的时间——调用方确认文案行作者就是帖主后，
        # 可把它当发帖时间兜底。
        'postDatetime': (to_iso(post_dt) or post_dt) if post_dt else None,
        'captionDatetime': (to_iso(cap_dt) or cap_dt) if cap_dt else None,
        'comments': rows_to_comments(rows, post_url, cap),
        'rawRowCount': len(rows),
        'counts': {
            'anchorsTotal': counts.get('anchorsTotal') or 0,
            'profileAnchors': counts.get('profileAnchors') or 0,
            'commentRowCandidates': counts.get('commentRowCandidates') or 0,
        },
        'hasCommentsContainer': bool(snap.get('hasCommentsContainer')),
        'navProfileUsername': snap.get('navProfileUsername'),
    }


def pick_owner_username(sources=None):
    """作者判定顺序（写死）：DOM 页头锚点 → 旧内嵌 JSON/og 的作者 → 文案行
    作者。绝不拿评论人当作者：评论行作者只有在前两路都没有时、且它就是
    文案行（评论列表第一行）时才用。"""
    s = sources or {}
    for v in (s.get('headerOwner'), s.get('payloadOwner'), s.get('captionAuthor')):
        u = re.sub(r'^@+', '', str(v or '').strip())
        if u:
            return u
    return ''


def merge_comments(primary, secondary, cap=50):
    """评论合并：主来源（可见 DOM）在前，次来源（旧内嵌 JSON）补缺，
    按 用户名|正文 去重，按 cap 截断。"""
    limit = cap if cap and cap > 0 else 50
    out = []
    seen = set()
    for c in list(primary or []) + list(secondary or []):
        if not isinstance(c, dict) or (not c.get('text') and not c.get('ownerUsername')):
            continue
        key = (c.get('ownerUsername') or '') + '|' + (c.get('text') or '')
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
        if len(out) >= limit:
            break
    return out


def needs_post_debug(post, comments):
    """帖子调试证据的基础触发条件：作者没读出来且评论 0 条
    （低产量触发在 collector 里另算，见 FIX C）。"""
    return bool(post) and not post.get('ownerUsername') and not comments


def _normalize_ws(s):
    return re.sub(r'\s+', ' ', str(s or '')).strip()


def filter_comment_rows(rows, owner, caption):
    """【FIX A】剔除文案行：评论行中 username == 帖主、且正文与文案在
    空白归一后完全一致的那行，是帖子文案本身，不是评论。
    帖主的真实评论（正文不同）不受影响；文案为空时不剔除任何行。
    输入/输出都是统一评论形状的 dict 列表。"""
    owner_u = str(owner or '').strip()
    cap_norm = _normalize_ws(caption)
    if not owner_u or not cap_norm:
        return list(rows or [])
    out = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        if str(r.get('ownerUsername') or '').strip() == owner_u \
                and _normalize_ws(r.get('text')) == cap_norm:
            continue  # 文案行
        out.append(r)
    return out


# ================= 页面内执行 JS（自包含，勿引用模块作用域） =================
# 背景（现场实测）：登录版 IG 帖子页上，旧的内嵌 JSON / og 读法经常拿不到
# 作者和评论（owner=未知、评论 0），但人眼在页面上明明能看到评论人。
# 所以改成“像人一样读可见 DOM”：下面三个片段在页面里执行，只用 document
# 全局和最基础的 DOM API，把页面结构读成纯数据快照。

# 把帖子页的可见结构读成快照：
# { title, headerUsernames[], rows[{username, segments[], datetime}],
#   counts{anchorsTotal, profileAnchors, commentRowCandidates},
#   hasCommentsContainer, navProfileUsername, postDatetime }
# 同时把评论列容器记在 document.__igcCommentsEl 上，供滚动片段复用。
HARVEST_POST_DOM_JS = r"""() => {
  var doc = document;
  var RESERVED = {
    p: 1, reel: 1, reels: 1, explore: 1, accounts: 1, stories: 1, direct: 1,
    tv: 1, about: 1, legal: 1, privacy: 1, terms: 1, help: 1, session: 1,
    challenge: 1, auth_platform: 1, graphql: 1, api: 1, web: 1, static: 1,
    developer: 1, blog: 1,
  };
  function usernameFromHref(href) {
    if (!href) return null;
    var m = String(href).match(/^(?:[a-z]+:\/\/[^/?#]+)?(\/[^?#]*)/i);
    var p = m ? m[1] : String(href);
    var mm = p.match(/^\/([A-Za-z0-9._]+)\/?$/);
    if (!mm) return null;
    if (RESERVED[mm[1].toLowerCase()]) return null;
    return mm[1];
  }
  function all(root, tag) {
    if (!root || !root.querySelectorAll) return [];
    return Array.prototype.slice.call(root.querySelectorAll(tag));
  }
  function isWithin(el, ancestor) {
    for (var n = el; n; n = n.parentElement) { if (n === ancestor) return true; }
    return false;
  }
  function profileAnchorsIn(root) {
    return all(root, 'a').filter(function (a) {
      return !!usernameFromHref(a.getAttribute('href'));
    });
  }
  function rowElementsIn(container) {
    var rows = [];
    function push(el) { if (rows.indexOf(el) < 0) rows.push(el); }
    var lis = all(container, 'li');
    for (var i = 0; i < lis.length; i++) {
      if (profileAnchorsIn(lis[i]).length > 0) push(lis[i]);
    }
    if (rows.length > 0) return rows;
    var anchors = profileAnchorsIn(container);
    for (var k = 0; k < anchors.length; k++) {
      var n = anchors[k];
      while (n && n.parentElement && n.parentElement !== container) n = n.parentElement;
      if (n && n.parentElement === container) push(n);
    }
    return rows;
  }
  function findCommentsContainer(scope) {
    // 0) 【定向滚动】文案行（评论列表里第一条带资料锚点的行）的可滚动
    //    祖先——桌面版右侧评论列正是它，优先用它，避免滚错容器。
    var scopeLis = all(scope, 'li');
    var firstRow = null;
    for (var fi = 0; fi < scopeLis.length; fi++) {
      if (profileAnchorsIn(scopeLis[fi]).length > 0) { firstRow = scopeLis[fi]; break; }
    }
    if (firstRow) {
      for (var anc = firstRow.parentElement; anc && anc !== doc.body; anc = anc.parentElement) {
        if ((anc.scrollHeight || 0) > (anc.clientHeight || 0) + 40) {
          return { el: anc, scrollable: true };
        }
      }
    }
    // 1) 可滚动元素里装资料锚点最多的那个（桌面版右侧评论列）
    var best = null, bestCount = -1;
    var cands = all(scope, 'div').concat(all(scope, 'ul'), all(scope, 'section'));
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      if ((el.scrollHeight || 0) > (el.clientHeight || 0) + 40) {
        var c = profileAnchorsIn(el).length;
        if (c > bestCount) { best = el; bestCount = c; }
      }
    }
    if (best) return { el: best, scrollable: true };
    // 2) 兜底：装了最多评论行候选的 ul/div（整页滚动布局）
    best = null; bestCount = 0;
    var lists = all(scope, 'ul').concat(all(scope, 'div'));
    for (var j = 0; j < lists.length; j++) {
      var cnt = rowElementsIn(lists[j]).length;
      if (cnt > bestCount) { best = lists[j]; bestCount = cnt; }
    }
    if (best && bestCount > 0) return { el: best, scrollable: false };
    return { el: null, scrollable: false };
  }
  function rowSegments(rowEl) {
    var segs = [];
    var spanTexts = [];
    function walk(el, isRoot) {
      if (!isRoot && el.tagName === 'LI') return;
      if (el.tagName === 'SPAN') spanTexts.push((el.textContent || '').trim());
      var kids = el.children || [];
      if (kids.length === 0) {
        var t = (el.textContent || '').trim();
        if (t) segs.push(t);
        return;
      }
      for (var i = 0; i < kids.length; i++) walk(kids[i], false);
    }
    walk(rowEl, true);
    var longest = '';
    for (var s = 0; s < spanTexts.length; s++) {
      if (spanTexts[s].length > longest.length) longest = spanTexts[s];
    }
    if (longest) segs.push(longest);
    return segs;
  }
  function navUsername() {
    var navs = all(doc, 'nav');
    for (var i = 0; i < navs.length; i++) {
      var as = all(navs[i], 'a');
      for (var j = 0; j < as.length; j++) {
        var u = usernameFromHref(as[j].getAttribute('href'));
        if (!u) continue;
        var label = as[j].getAttribute('aria-label') || '';
        if (all(as[j], 'img').length > 0 || /profile/i.test(label)) return u;
      }
    }
    return null;
  }

  var article = doc.querySelector('article');
  var scope = article || doc;
  var found = findCommentsContainer(scope);
  var container = found.el;
  if (container) { try { doc.__igcCommentsEl = container; } catch (e) { /* 忽略 */ } }

  var rows = [];
  var rowEls = container ? rowElementsIn(container) : [];
  if (container) {
    for (var r = 0; r < rowEls.length; r++) {
      var rowEl = rowEls[r];
      var pas = profileAnchorsIn(rowEl);
      if (!pas.length) continue;
      var uname = usernameFromHref(pas[0].getAttribute('href'));
      if (!uname) continue;
      var timeEl = rowEl.querySelector ? rowEl.querySelector('time') : null;
      rows.push({
        username: uname,
        segments: rowSegments(rowEl),
        datetime: timeEl ? (timeEl.getAttribute('datetime') || null) : null,
      });
    }
  }

  var headerUsernames = [];
  var headerEl = article ? article.querySelector('header') : null;
  if (headerEl) {
    var has = profileAnchorsIn(headerEl);
    for (var a = 0; a < has.length; a++) {
      var hu = usernameFromHref(has[a].getAttribute('href'));
      if (hu && headerUsernames.indexOf(hu) < 0) headerUsernames.push(hu);
    }
  } else if (article && container) {
    var pre = [];
    var scopeAnchors = profileAnchorsIn(article);
    for (var h = 0; h < scopeAnchors.length; h++) {
      if (isWithin(scopeAnchors[h], container)) break;
      var pu = usernameFromHref(scopeAnchors[h].getAttribute('href'));
      if (pu) pre.push(pu);
    }
    if (pre.length) headerUsernames = [pre[pre.length - 1]];
  }

  var postDatetime = null;
  var timeEls = all(scope, 'time');
  for (var ti = 0; ti < timeEls.length; ti++) {
    var inRow = false;
    for (var rj = 0; rj < rowEls.length; rj++) {
      if (isWithin(timeEls[ti], rowEls[rj])) { inRow = true; break; }
    }
    if (inRow) continue;
    var dtv = timeEls[ti].getAttribute('datetime');
    if (dtv) { postDatetime = dtv; break; }
  }

  return {
    title: doc.title || '',
    headerUsernames: headerUsernames,
    rows: rows,
    postDatetime: postDatetime,
    counts: {
      anchorsTotal: all(doc, 'a').length,
      profileAnchors: profileAnchorsIn(scope).length,
      commentRowCandidates: rows.length,
    },
    hasCommentsContainer: !!container,
    navProfileUsername: navUsername(),
  };
}"""

# 把 harvest 时标记的评论列滚到底；标记丢了（页面重渲染）就重新找一次。
# 返回 { found, scrolled, scrollHeight }（只有结构信息）。
SCROLL_COMMENTS_JS = r"""() => {
  var doc = document;
  function all(root, tag) {
    if (!root || !root.querySelectorAll) return [];
    return Array.prototype.slice.call(root.querySelectorAll(tag));
  }
  var el = null;
  try { el = doc.__igcCommentsEl || null; } catch (e) { /* 忽略 */ }
  if (!el) {
    var article = doc.querySelector('article');
    var scope = article || doc;
    var cands = all(scope, 'div').concat(all(scope, 'ul'), all(scope, 'section'));
    var bestCount = -1;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if ((c.scrollHeight || 0) > (c.clientHeight || 0) + 40) {
        var n = all(c, 'a').length;
        if (n > bestCount) { el = c; bestCount = n; }
      }
    }
    if (el) { try { doc.__igcCommentsEl = el; } catch (e) { /* 忽略 */ } }
  }
  if (!el) return { found: false, scrolled: false, scrollHeight: 0 };
  var before = el.scrollTop || 0;
  try { el.scrollTop = el.scrollHeight; } catch (e) { /* 忽略 */ }
  return { found: true, scrolled: (el.scrollTop || 0) !== before, scrollHeight: el.scrollHeight || 0 };
}"""

# 左侧导航里的本人资料锚点用户名（带头像图或 aria-label 含 Profile）。
NAV_PROFILE_USERNAME_JS = r"""() => {
  var doc = document;
  var RESERVED = {
    p: 1, reel: 1, reels: 1, explore: 1, accounts: 1, stories: 1, direct: 1,
    tv: 1, about: 1, legal: 1, privacy: 1, terms: 1, help: 1, session: 1,
    challenge: 1, auth_platform: 1, graphql: 1, api: 1, web: 1, static: 1,
    developer: 1, blog: 1,
  };
  function usernameFromHref(href) {
    if (!href) return null;
    var m = String(href).match(/^(?:[a-z]+:\/\/[^/?#]+)?(\/[^?#]*)/i);
    var p = m ? m[1] : String(href);
    var mm = p.match(/^\/([A-Za-z0-9._]+)\/?$/);
    if (!mm) return null;
    if (RESERVED[mm[1].toLowerCase()]) return null;
    return mm[1];
  }
  function all(root, tag) {
    if (!root || !root.querySelectorAll) return [];
    return Array.prototype.slice.call(root.querySelectorAll(tag));
  }
  var navs = all(doc, 'nav');
  for (var i = 0; i < navs.length; i++) {
    var as = all(navs[i], 'a');
    for (var j = 0; j < as.length; j++) {
      var u = usernameFromHref(as[j].getAttribute('href'));
      if (!u) continue;
      var label = as[j].getAttribute('aria-label') || '';
      if (all(as[j], 'img').length > 0 || /profile/i.test(label)) return u;
    }
  }
  return null;
}"""


# 在博主资料页里读原始材料（粉丝数不在这里定案，交回 Python 按
# meta → JSON → 链接文本 的优先顺序定，见 bloggers.parse_followers_from_meta）：
# { username, followersFromJson, linkCandidates[], metaDescription,
#   isBusiness, category, bio }
HARVEST_PROFILE_JS = r"""(profileUsername) => {
  var doc = document;
  function findUserNode(root) {
    var queue = [root];
    var seen = [];
    var steps = 0;
    while (queue.length && steps++ < 6000) {
      var cur = queue.shift();
      if (!cur || typeof cur !== 'object') continue;
      if (seen.indexOf(cur) >= 0) continue;
      seen.push(cur);
      if (cur.edge_followed_by || cur.is_business_account !== undefined || typeof cur.biography === 'string') {
        return cur;
      }
      for (var k in cur) {
        var v = cur[k];
        if (v && typeof v === 'object') queue.push(v);
      }
    }
    return null;
  }
  function all(root, tag) {
    if (!root || !root.querySelectorAll) return [];
    return Array.prototype.slice.call(root.querySelectorAll(tag));
  }

  var followersFromJson = null;
  var isBusiness = null;
  var category = null;
  var bio = null;

  var scripts = [];
  try { scripts = all(doc, 'script[type="application/json"]'); } catch (e) { /* 忽略 */ }
  for (var i = 0; i < scripts.length; i++) {
    var text = scripts[i].textContent || '';
    if (text.indexOf('edge_followed_by') < 0 &&
        text.indexOf('is_business_account') < 0 &&
        text.indexOf('biography') < 0) continue;
    var data = null;
    try { data = JSON.parse(text); } catch (e) { continue; }
    var node = findUserNode(data);
    if (!node) continue;
    if (node.edge_followed_by && typeof node.edge_followed_by.count === 'number') {
      followersFromJson = node.edge_followed_by.count;
    }
    if (node.is_business_account !== undefined && node.is_business_account !== null) {
      isBusiness = !!node.is_business_account;
    }
    if (typeof node.category_name === 'string' && node.category_name) category = node.category_name;
    if (typeof node.biography === 'string' && node.biography) bio = node.biography;
    if (followersFromJson !== null && bio) break;
  }

  // 粉丝链接的可见文本/title 原样收集（Python 侧解析）
  var linkCandidates = [];
  var links = [];
  try { links = all(doc, 'a[href]'); } catch (e) { /* 忽略 */ }
  for (var j = 0; j < links.length; j++) {
    var href = links[j].getAttribute('href') || '';
    if (href.indexOf('/followers') < 0) continue;
    var t = (links[j].textContent || '').trim();
    if (t) linkCandidates.push(t);
    var lt = links[j].getAttribute('title');
    if (lt) linkCandidates.push(lt);
    var spans = links[j].querySelectorAll ? links[j].querySelectorAll('span[title]') : [];
    for (var s2 = 0; s2 < spans.length; s2++) {
      var ti = spans[s2].getAttribute('title');
      if (ti) linkCandidates.push(ti);
    }
  }

  var metaDescription = null;
  try {
    var meta = doc.querySelector('meta[name="description"]') ||
               doc.querySelector('meta[property="og:description"]');
    if (meta) metaDescription = meta.getAttribute('content') || null;
  } catch (e) { /* 忽略 */ }

  return {
    username: profileUsername || '',
    followersFromJson: followersFromJson,
    linkCandidates: linkCandidates,
    metaDescription: metaDescription,
    isBusiness: isBusiness,
    category: category,
    bio: bio,
  };
}"""

OG_META_JS = r"""() => {
  const get = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.getAttribute('content') : null;
  };
  return {
    ogDesc: get('meta[property="og:description"]'),
    ogImage: get('meta[property="og:image"]'),
  };
}"""


# ================= Playwright 包装（page 为鸭子类型，不 import playwright） =================

import random as _random

import bloggers as _bloggers


def _small_pause():
    time.sleep(_random.uniform(1.2, 2.5))


def harvest_snapshot(page):
    try:
        return page.evaluate(HARVEST_POST_DOM_JS)
    except Exception:
        return None


def extract_post_data(page, link, comments_cap=50):
    """从帖子页提取数据：可见 DOM 优先（作者看页头锚点、文案看文案行），
    页面内嵌 JSON 退为兜底合并来源，og 元信息补计数。
    link = {'shortCode', 'url'}。返回
    {'post', 'payloadComments', 'domComments', 'domMeta'}。"""
    try:
        page.wait_for_load_state('load', timeout=12000)
    except Exception:
        pass
    time.sleep(1.5)

    snap = harvest_snapshot(page)
    dom = analyze_snapshot(snap, link['url'], comments_cap) if snap else None

    result = None
    try:
        html = page.content()
        result = extract_post_from_text(html, link['url'])
    except Exception:
        pass

    og = {'ogDesc': None, 'ogImage': None}
    try:
        got = page.evaluate(OG_META_JS)
        if isinstance(got, dict):
            og = got
    except Exception:
        pass

    post = (result or {}).get('post') or {
        'id': None, 'shortCode': link['shortCode'], 'type': '', 'caption': '',
        'hashtags': [], 'mentions': [], 'url': link['url'], 'likesCount': None,
        'commentsCount': None, 'timestamp': None, 'displayUrl': '', 'videoUrl': '',
        'ownerUsername': '', 'ownerFullName': '',
    }
    # 作者判定顺序（写死）：DOM 页头锚点 → 内嵌 JSON 作者 → 文案行作者。
    owner = pick_owner_username({
        'headerOwner': dom['headerOwner'] if dom else '',
        'payloadOwner': post.get('ownerUsername'),
        'captionAuthor': dom['captionAuthor'] if dom else '',
    })
    if owner:
        post['ownerUsername'] = owner
    # 文案：JSON 没有时用 DOM 文案行的正文（且文案行作者必须就是最终作者）
    if not post.get('caption') and dom and dom['captionText'] and dom['captionAuthor'] \
            and dom['captionAuthor'] == post.get('ownerUsername'):
        post['caption'] = dom['captionText']
        post['hashtags'] = extract_hashtags(post['caption'])
    counts = parse_og_counts(og.get('ogDesc'))
    if post.get('likesCount') is None:
        post['likesCount'] = counts['likesCount']
    if post.get('commentsCount') is None:
        post['commentsCount'] = counts['commentsCount']
    if not post.get('displayUrl') and og.get('ogImage'):
        post['displayUrl'] = og['ogImage']
    if not post.get('url'):
        post['url'] = link['url']
    if not post.get('shortCode'):
        post['shortCode'] = link['shortCode']
    # 发布时间（新鲜度筛选用）：内嵌 JSON 的 taken_at 优先；其次 DOM 里
    # 评论行之外的帖子日期；再不行用文案行的时间（文案行作者已确认是
    # 帖主时，它的时间就是发帖时间）。都拿不到保持 None、来源标 unknown。
    timestamp_source = 'unknown'
    if post.get('timestamp'):
        timestamp_source = 'json'
    elif dom and dom.get('postDatetime'):
        post['timestamp'] = dom['postDatetime']
        timestamp_source = 'dom'
    elif dom and dom.get('captionDatetime') and post.get('ownerUsername') \
            and dom['captionAuthor'] == post['ownerUsername']:
        post['timestamp'] = dom['captionDatetime']
        timestamp_source = 'dom'
    post['timestampSource'] = timestamp_source
    return {
        'post': post,
        'payloadComments': (result or {}).get('comments') or [],
        'domComments': dom['comments'] if dom else [],
        'domMeta': {'counts': dom['counts'], 'hasCommentsContainer': dom['hasCommentsContainer']}
        if dom else None,
    }


_EXPAND_TEXT_RE = re.compile(
    r'view all|view more|load more|查看全部|查看更多|加载更多|展开评论', re.I)
_EXPAND_LABEL_SELECTOR = ('button[aria-label*="Load more"], [role="button"][aria-label*="Load more"], '
                          'button[aria-label*="更多评论"], [role="button"][aria-label*="更多评论"]')


def _click_expand_comments(page):
    """【FIX B】点一次“查看全部评论 / Load more comments”类展开控件
    （含 aria-label 的圆形加载按钮）。点到返回 True，没有返回 False。"""
    try:
        btn = page.get_by_text(_EXPAND_TEXT_RE).first
        btn.click(timeout=2500)
        return True
    except Exception:
        pass
    try:
        btn = page.locator(_EXPAND_LABEL_SELECTOR).first
        btn.click(timeout=2500)
        return True
    except Exception:
        return False


def collect_post_comments(page, link, limit, data):
    """评论采集：以可见 DOM 为主来源——先合并 extract_post_data 已收割的
    一屏，不够就展开+滚评论列逐轮重收割；旧内嵌 JSON 评论作次来源合并。
    【FIX B】展开控件最多点 3 次（开滚前 + 滚动轮次间补点）；滚动优先滚
    评论列容器（页面内已按文案行祖先定位并标记），标记丢失才整页滚。
    连续两轮没有新评论就停。返回 {'comments', 'meta'}。"""
    post_url = (data['post'] or {}).get('url') or link['url']
    merged = merge_comments(data.get('domComments'), data.get('payloadComments'), limit)
    meta = data.get('domMeta')

    clicks = 0
    while clicks < 3 and len(merged) < limit:
        if not _click_expand_comments(page):
            break
        clicks += 1
        _small_pause()

    stagnant = 0
    for _round in range(12):
        if len(merged) >= limit:
            break
        scrolled = None
        try:
            scrolled = page.evaluate(SCROLL_COMMENTS_JS)
        except Exception:
            pass
        if not (isinstance(scrolled, dict) and scrolled.get('found')):
            try:
                page.mouse.wheel(0, 900)  # 整页滚动兜底
            except Exception:
                pass
        _small_pause()

        snap = harvest_snapshot(page)
        if not snap:
            break
        dom = analyze_snapshot(snap, post_url, 200)
        meta = {'counts': dom['counts'], 'hasCommentsContainer': dom['hasCommentsContainer']}
        before = len(merged)
        merged = merge_comments(dom['comments'], merged, limit)
        if len(merged) >= limit:
            break
        if clicks < 3 and _click_expand_comments(page):
            clicks += 1
            _small_pause()
        if len(merged) == before:
            stagnant += 1
            if stagnant >= 2:
                break
        else:
            stagnant = 0
    return {'comments': merged, 'meta': meta}


def harvest_post(page, link, comments_limit=50):
    """整帖收割：extract_post_data + collect_post_comments 一条龙。
    返回 {'post', 'comments', 'meta', 'statedCount'}：
    comments 是合并去重后的全部评论行（未过文案行剔除/意向筛选，
    由 collector 统一处理）；statedCount 是页面自报的评论总数
    （内嵌 JSON 的 edge_media_to_parent_comment.count /
    edge_media_to_comment.count，og 兜底），读不到为 None。"""
    data = extract_post_data(page, link, comments_limit)
    cres = collect_post_comments(page, link, comments_limit, data)
    return {
        'post': data['post'],
        'comments': cres['comments'],
        'meta': cres['meta'],
        'statedCount': data['post'].get('commentsCount'),
    }


def harvest_profile(page, username):
    """博主资料页收割：页面内先拿原始材料，粉丝数在 Python 侧按
    【meta description → 内嵌 JSON → 粉丝链接文本】的顺序定案
    （meta 第一优先是实地修复：JS 版没读它，跑出过“粉丝 未知”）。
    返回 {'username', 'followers', 'isBusiness', 'category', 'bio'}。"""
    raw = None
    try:
        raw = page.evaluate(HARVEST_PROFILE_JS, username)
    except Exception:
        raw = None
    if not isinstance(raw, dict):
        return {'username': username, 'followers': None, 'isBusiness': None,
                'category': None, 'bio': None}
    followers = _bloggers.parse_followers_from_meta(raw.get('metaDescription'))
    if followers is None and raw.get('followersFromJson') is not None:
        n = raw['followersFromJson']
        followers = int(round(n)) if isinstance(n, (int, float)) and math.isfinite(n) else None
    if followers is None:
        for cand in raw.get('linkCandidates') or []:
            followers = _bloggers.parse_follower_count(cand)
            if followers is not None:
                break
    bio = raw.get('bio') or _bloggers.parse_bio_from_meta(raw.get('metaDescription'))
    return {
        'username': username,
        'followers': followers,
        'isBusiness': raw.get('isBusiness'),
        'category': raw.get('category'),
        'bio': bio,
    }
