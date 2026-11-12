# -*- coding: utf-8 -*-
"""会话文件解析模块（纯函数，不 import playwright，可单测）。

移植自 JS 版 src/session.js + src/cookiesDir.js 的诊断部分。IG 没有官方的
.session 文件，能“拿文件直登”的等价物就是 cookie / storageState 文件，
本模块负责把卖家/浏览器给的各种导出文本读成 Playwright 能用的 cookie。

认得的文本格式（analyze_text / analyze_session_buffer）：
  - JSON 裸数组、{cookies:[...]} 对象、storageState
  - JSON 扁平字典对象 {名字: 值, ...}（含 sessionid 才算可用）
  - 带首行标签行的上述 JSON（自动剥杂质）
  - 整份 JSON 被 Base64 包装（可折行/带空格/base64url 变体）
  - 标签与 Base64 粘在同一行、只以冒号分隔（如 PCBM:<Base64>），以及卖家
    整行格式 用户名:密码:邮箱:标记:Base64 —— 逐个冒号切分试尾串，能解出
    cookie 数组的第一个尾串胜出；整行里的用户名只作黑名单预检与体检显示，
    密码/邮箱字段绝不进任何返回值、日志和报错。
  - Netscape HTTP Cookie File（经典 cookies.txt，7 段 TAB 分隔，认 #HttpOnly_ 行）
  - Cookie 头风格 name=value; name2=value2（单行/多行，可带 Cookie: 前缀）
文件编码：UTF-8（含 BOM）、UTF-16LE / UTF-16BE（带 BOM，或无 BOM 靠 NUL 分布猜）。

安全红线（写死）：
- 会话/cookie 文件等于账号钥匙（等同 TG 的 .session），谁持有谁就能登号。
- 本模块的任何返回值摘要、错误信息、日志都不包含 cookie 的值（value），
  只允许出现 cookie 的名字（如 sessionid）。报错也只点名缺哪个 cookie。
"""
import base64
import json
import math
import re
from datetime import datetime, timezone

# IG 登录关键 cookie：sessionid 是登录态本身，缺了它等于没登录。
LOGIN_CRITICAL_COOKIES = ['sessionid', 'csrftoken', 'ds_user_id']
IG_DOMAIN = '.instagram.com'

# 检测到的格式 → --check-cookies 里显示的名字
FORMAT_LABELS = {
    'json-array': 'json数组',
    'json-object': 'json对象',
    'json-dict': 'json对象',
    'base64': 'base64包装',
    'netscape': 'netscape',
    'cookie-header': 'cookie头',
    'unknown': '未知',
}


class SessionParseError(Exception):
    """解析失败。只带错误类别 code 和（可选）认出的格式，绝不带 cookie 值。"""

    def __init__(self, message, code=None, format_detected=None):
        super().__init__(message)
        self.code = code
        self.format_detected = format_detected


def is_instagram_domain(domain):
    if domain is None or domain == '':
        return True  # 没写域名按 IG 处理（导出文件常省略）
    d = str(domain).strip().lower().lstrip('.')
    return d == 'instagram.com' or d.endswith('.instagram.com')


def map_same_site(v):
    """大小写不敏感；无法对应的值返回 None，表示省略该字段（不要硬塞默认值）。"""
    if v is None:
        return None
    s = str(v).strip().lower()
    if s == 'strict':
        return 'Strict'
    if s in ('none', 'no_restriction'):
        return 'None'
    if s == 'lax':
        return 'Lax'
    return None


def _parse_date_to_epoch(s):
    """字符串日期 → epoch 秒；认不出返回 None（对应 JS 的 Date.parse）。"""
    t = str(s).strip()
    if not t:
        return None
    try:
        dt = datetime.fromisoformat(t.replace('Z', '+00:00').replace('z', '+00:00'))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except ValueError:
        pass
    # RFC 1123 等英文日期格式兜底
    try:
        from email.utils import parsedate_to_datetime
        dt = parsedate_to_datetime(t)
        if dt is not None:
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp())
    except Exception:
        pass
    return None


def to_expires(cookie):
    # 会话型 cookie（导出里标了 session:true，如经典的 rur 条目）一律 -1：
    # 它按定义没有到期时间，就算源文件顺带写了一个 expirationDate 也不作数——
    # 写成 0 / 过去的时间戳，浏览器会把这个 cookie 静默丢掉，会话就“被失效”了。
    if cookie.get('session') is True:
        return -1
    e = cookie.get('expires')
    if e is None:
        e = cookie.get('expirationDate')
    if e is None or e == '':
        return -1  # 没写到期 = 会话 cookie
    if isinstance(e, str):
        parsed = _parse_date_to_epoch(e)
        if parsed is not None:
            return parsed
        try:
            e = float(e)
        except ValueError:
            return -1
    try:
        n = float(e)
    except (TypeError, ValueError):
        return -1
    # 0 / 负数 / NaN 都不是合法到期时间（Playwright 里 -1 才是“会话 cookie”），
    # 一律归一到 -1，绝不能把 0 或 NaN 透传给浏览器（会被当成已过期丢弃）。
    if not math.isfinite(n) or n <= 0:
        return -1
    return math.floor(n)


def normalize_cookie(raw):
    """把一条原始 cookie 补齐成 Playwright 形状；不属于 IG 域名的返回 None。"""
    if not isinstance(raw, dict):
        return None
    name = str(raw.get('name') or '').strip()
    if not name:
        return None
    if not is_instagram_domain(raw.get('domain')):
        return None
    # value 必须逐字节原样透传：不解码、不重新编码、不裁剪。
    # sessionid 本身就是 URL 编码过的（含 %3A 等），任何“顺手处理”
    # 都会让服务器不认这把钥匙，把活会话误判成失效。
    value = raw.get('value')
    value = '' if value is None else str(value)
    cookie = {
        'name': name,
        'value': value,
        'domain': IG_DOMAIN,
        'path': str(raw['path']) if raw.get('path') else '/',
        'expires': to_expires(raw),
        # sessionid 本身是 httpOnly；其余按原值，没有就默认 False
        'httpOnly': bool(raw['httpOnly']) if raw.get('httpOnly') is not None else name == 'sessionid',
        'secure': bool(raw['secure']) if raw.get('secure') is not None else True,
    }
    same_site = map_same_site(raw.get('sameSite'))
    if same_site:
        cookie['sameSite'] = same_site  # 无法对应时省略，不硬塞
    return cookie


def convert_raw_cookies(raw_cookies, raw_origins=None):
    """原始 cookie 数组 → {cookies, origins, names}（不抛错版）。

    names 是转换前全部 cookie 的名字（已去重），只用于体检报告——
    名字可以报，值永远不报。缺 sessionid 时 cookies 仍给出，由调用方决定报错口径。
    """
    names = []
    seen = set()
    by_key = {}
    for raw in raw_cookies or []:
        if isinstance(raw, dict) and raw.get('name') and str(raw['name']) not in seen:
            seen.add(str(raw['name']))
            names.append(str(raw['name']))
        c = normalize_cookie(raw)
        if c is None:
            continue
        by_key[c['name'] + '|' + c['domain'] + '|' + c['path']] = c  # 后出现的覆盖先出现的
    origins = []
    for o in raw_origins or []:
        if not isinstance(o, dict):
            continue
        origin = str(o.get('origin') or '')
        m = re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+)', origin)
        host = m.group(1) if m else ''
        if host and is_instagram_domain(host.split(':')[0]):
            origins.append(o)
    return {'cookies': list(by_key.values()), 'origins': origins, 'names': names}


def missing_sessionid_error():
    err = SessionParseError(
        '会话文件里缺少关键 cookie：sessionid（没有它等于没有登录态）。'
        '请确认导出的是已登录 Instagram 的会话/cookie。',
        code='missing_sessionid')
    return err


def to_storage_state(data):
    """任意输入（裸 cookie 数组 / {cookies:[...]} / storageState）→ storageState。

    强制要求 sessionid 存在；缺失时抛 SessionParseError，错误只写 cookie 名字。
    """
    raw_cookies = None
    raw_origins = []
    if isinstance(data, list):
        raw_cookies = data
    elif isinstance(data, dict) and isinstance(data.get('cookies'), list):
        raw_cookies = data['cookies']
        if isinstance(data.get('origins'), list):
            raw_origins = data['origins']
    if raw_cookies is None:
        raise SessionParseError(
            '会话文件格式不对：没有找到 cookies 数组。'
            '请确认导出的文件是 cookie JSON 或本工具的 .storage.json。',
            code='no_cookies_array')
    conv = convert_raw_cookies(raw_cookies, raw_origins)
    if not any(c['name'] == 'sessionid' for c in conv['cookies']):
        raise missing_sessionid_error()
    return {'cookies': conv['cookies'], 'origins': conv['origins']}


def to_playwright_cookies(storage_state):
    """storageState → 可直接喂给 Playwright context.add_cookies 的 cookie 列表。

    只保留 Playwright 接受的字段，逐条复制（不改值、不改到期语义）。
    """
    out = []
    for c in (storage_state or {}).get('cookies') or []:
        cookie = {
            'name': c['name'],
            'value': c['value'],
            'domain': c.get('domain') or IG_DOMAIN,
            'path': c.get('path') or '/',
            'expires': c.get('expires', -1),
            'httpOnly': bool(c.get('httpOnly')),
            'secure': bool(c.get('secure')),
        }
        if c.get('sameSite'):
            cookie['sameSite'] = c['sameSite']
        out.append(cookie)
    return out


def summarize_state(state):
    """只读摘要：可以安全打印/写日志——只有 cookie 名字和数量，绝不含值。"""
    cookies = state.get('cookies') if isinstance(state, dict) else None
    cookies = cookies if isinstance(cookies, list) else []
    return {
        'cookieCount': len(cookies),
        'cookieNames': sorted({c['name'] for c in cookies}),
        'hasSessionid': any(c['name'] == 'sessionid' for c in cookies),
        'loginCriticalPresent': [n for n in LOGIN_CRITICAL_COOKIES
                                 if any(c['name'] == n for c in cookies)],
    }


def has_cookie(state, name):
    cookies = state.get('cookies') if isinstance(state, dict) else None
    return isinstance(cookies, list) and any(c.get('name') == name for c in cookies)


# ---------------------------------------------------------------------------
# 文件编码层：Windows 记事本另存的文件可能是 UTF-8 BOM / UTF-16LE / UTF-16BE，
# 直接按 UTF-8 读会读成乱码或带 NUL 的废文本，任何格式都解不出。
# 这里先把字节解成文本：认 BOM；无 BOM 时靠 NUL 字节分布猜 UTF-16
# （纯 UTF-8 文本几乎不含 NUL，所以误判风险低）。
# ---------------------------------------------------------------------------
def decode_buffer_text(buf):
    if not buf:
        return {'text': '', 'encoding': 'empty'}
    buf = bytes(buf)
    if len(buf) >= 3 and buf[0] == 0xEF and buf[1] == 0xBB and buf[2] == 0xBF:
        return {'text': buf[3:].decode('utf-8', errors='replace'), 'encoding': 'utf8-bom'}
    if len(buf) >= 2 and buf[0] == 0xFF and buf[1] == 0xFE:
        return {'text': buf[2:].decode('utf-16-le', errors='replace'), 'encoding': 'utf16le'}
    if len(buf) >= 2 and buf[0] == 0xFE and buf[1] == 0xFF:
        return {'text': buf[2:].decode('utf-16-be', errors='replace'), 'encoding': 'utf16be'}
    if len(buf) >= 4 and len(buf) % 2 == 0:
        even_zero = 0
        odd_zero = 0
        pairs = len(buf) // 2
        for i in range(0, len(buf), 2):
            if buf[i] == 0:
                even_zero += 1
            if buf[i + 1] == 0:
                odd_zero += 1
        # UTF-16LE 的 ASCII 字符高字节在奇数位、是 0；UTF-8 文本两边都几乎不会有 0
        if odd_zero / pairs >= 0.25 and even_zero / pairs < 0.05:
            return {'text': buf.decode('utf-16-le', errors='replace'), 'encoding': 'utf16le-guess'}
        if even_zero / pairs >= 0.25 and odd_zero / pairs < 0.05:
            return {'text': buf.decode('utf-16-be', errors='replace'), 'encoding': 'utf16be-guess'}
    return {'text': buf.decode('utf-8', errors='replace'), 'encoding': 'utf8'}


# 纯文本解析（第 1、2 步）：先整段 json.loads；失败时做方括号截取——
# 剥掉第一个 '[' 之前（或 '{' 之前）的标题/标签行等杂质再试。
# 成功返回解析结果，失败返回 None（用哨兵区分“解析出 JSON null”）。
_PARSE_FAILED = object()


def try_parse_json_text(raw):
    try:
        return json.loads(raw)
    except Exception:
        sliced = None
        arr_start = raw.find('[')
        arr_end = raw.rfind(']')
        if arr_start >= 0 and arr_end > arr_start:
            sliced = raw[arr_start:arr_end + 1]
        else:
            obj_start = raw.find('{')
            obj_end = raw.rfind('}')
            if obj_start >= 0 and obj_end > obj_start:
                sliced = raw[obj_start:obj_end + 1]
        if sliced is not None:
            try:
                return json.loads(sliced)
            except Exception:
                pass
    return _PARSE_FAILED


def is_base64_shaped(s):
    """判断一段去掉空白的字符串是否长得像 Base64（标准或 URL 安全变体都认）。"""
    if not s or len(s) < 16:
        return False
    mapped = s.replace('-', '+').replace('_', '/')
    if not re.fullmatch(r'[A-Za-z0-9+/]+={0,2}', mapped):
        return False
    # 去掉填充后长度 mod 4 不能为 1（那种长度不可能是合法 Base64）
    if len(mapped.rstrip('=')) % 4 == 1:
        return False
    return True


def decode_base64(s):
    mapped = s.replace('-', '+').replace('_', '/')
    mapped += '=' * (-len(mapped) % 4)
    return base64.b64decode(mapped).decode('utf-8', errors='replace')


def base64_candidates(raw):
    """第 3 步（Base64 恢复）的候选串，按成功概率排序，逐个试解码。

    每个候选是 {'text':..., 'colonIndex':...}：colonIndex 是它由哪个冒号
    切分出来的（在原文中的位置），非冒号切分的候选为 None——胜出候选的
    colonIndex 用来在原文里定位卖家整行的字段（见 detect_seller_username）。
      a) 去掉首行（标签行）后全文去空白 —— 卖家文件常见“标题行 + Base64 正文”
      b) 全文去空白 —— 无标签行、可能按固定宽度折行或字符组间带空格的 Base64
      c) 只保留本身像 Base64 的行再拼接 —— 标签行混在中间时兜底
      d) 逐个冒号切分：原文里每一个 ':' 之后的尾巴，去空白后整体像 Base64
         的都收 —— 覆盖 PCBM:<Base64>（标签粘连）和卖家整行
         用户名:密码:邮箱:标记:<Base64>（密码字段本身带冒号也行，因为
         带冒号的中间尾巴过不了形状检查，只有真正的 Base64 尾巴能胜出）
    解码或解析失败的候选直接跳过，不抛错、不打印任何文件内容。
    """
    def strip(s):
        return re.sub(r'\s+', '', str(s))

    text = str(raw)
    lines = re.split(r'\r?\n', text)
    non_empty = [l for l in lines if strip(l)]
    cands = []
    seen = set()

    def push(t, colon_index):
        if not is_base64_shaped(t) or t in seen:
            return
        seen.add(t)
        cands.append({'text': t, 'colonIndex': colon_index})

    if len(non_empty) > 1:
        push(strip(''.join(non_empty[1:])), None)
    push(strip(text), None)
    shaped_only = [l for l in non_empty if is_base64_shaped(strip(l))]
    if 0 < len(shaped_only) < len(non_empty):
        push(strip(''.join(shaped_only)), None)
    for i, ch in enumerate(text):
        if ch != ':':
            continue
        push(strip(text[i + 1:]), i)
    return cands


def detect_seller_username(text, colon_index):
    """卖家整行元数据：胜出尾串来自冒号切分时，看冒号之前那一行按 ':' 切开
    的字段：字段数 ≥3、且有字段含 '@'（邮箱），才认定这是
    “用户名:密码:邮箱:...”整行，取第 1 个字段作账号名候选。

    用途只有两个：--check-cookies 显示“账号：<用户名>”，以及开浏览器之前
    的主号黑名单预检。密码、邮箱字段绝不从这里出去——本函数只返回用户名。
    """
    if colon_index is None or colon_index < 0:
        return None
    head = str(text)[:colon_index]
    line = re.split(r'\r?\n', head)[-1] or ''
    fields = line.split(':')
    if len(fields) < 3:
        return None
    if not any('@' in f for f in fields):
        return None
    username = fields[0].strip()
    # 账号名只可能是 IG 用户名字符集；长得不像就当没有，免得误报
    if not re.fullmatch(r'[A-Za-z0-9._]+', username):
        return None
    return username


# ---------------------------------------------------------------------------
# Netscape HTTP Cookie File（经典 cookies.txt）：每行 7 段 TAB 分隔：
#   domain  flag  path  secure  expiration  name  value
# 以 # 开头的是注释行，唯独 "#HttpOnly_" 前缀的行是真 cookie（去掉前缀、
# 标记 httpOnly）。curl / yt-dlp / 各种浏览器扩展导出的就是这种。
# ---------------------------------------------------------------------------
def parse_netscape_line(line):
    http_only = False
    s = line
    if s.startswith('#HttpOnly_'):
        http_only = True
        s = s[len('#HttpOnly_'):]
    elif s.startswith('#'):
        return None
    fields = s.split('\t')
    if len(fields) < 7:
        return None
    name = (fields[5] or '').strip()
    if not name or re.search(r'[\s=;]', name):
        return None
    try:
        expires = float(fields[4])
    except (TypeError, ValueError):
        expires = -1
    return {
        'domain': (fields[0] or '').strip(),
        'path': (fields[2] or '').strip() or '/',
        'secure': bool(re.match(r'(?i)^true$', (fields[3] or '').strip())),
        'expires': expires or -1,
        'name': name,
        # value 是最后一段；万一值里混了 TAB，把第 7 段起拼回去
        'value': '\t'.join(fields[6:]),
        'httpOnly': http_only,
    }


def try_parse_netscape(text):
    cookies = []
    for line in re.split(r'\r?\n', str(text)):
        if not line or not line.strip():
            continue
        c = parse_netscape_line(line)
        if c:
            cookies.append(c)
    return cookies if cookies else None


# ---------------------------------------------------------------------------
# Cookie 头风格：name=value; name2=value2（单行或多行，每行可带 Cookie: 前缀）。
# 判定从严：文本里不能有 JSON 的 { } [ ]；按行、按 ; 切开后，每段都必须
# 是合法的 name=value；至少 2 对，或者唯一 1 对就是 sessionid，才认定。
# ---------------------------------------------------------------------------
COOKIE_NAME_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")


def try_parse_cookie_header(text):
    raw = str(text)
    if re.search(r'[{}[\]]', raw):
        return None
    pairs = []
    for line in re.split(r'\r?\n', raw):
        line = line.strip()
        if not line:
            continue
        line = re.sub(r'(?i)^cookie\s*:\s*', '', line)
        for seg_raw in line.split(';'):
            seg = seg_raw.strip()
            if not seg:
                continue
            eq = seg.find('=')
            if eq <= 0:
                return None  # 有一段不是 name=value → 整体不是 Cookie 头
            name = seg[:eq].strip()
            if not COOKIE_NAME_RE.match(name):
                return None
            pairs.append({'name': name, 'value': seg[eq + 1:].strip()})
    if not pairs:
        return None
    if len(pairs) == 1 and pairs[0]['name'] != 'sessionid':
        return None
    return pairs


def try_dict_cookies(parsed):
    """扁平字典 JSON：{ "sessionid": "...", ... }；顶层每个值都必须是
    字符串/数字才认定。"""
    if not isinstance(parsed, dict):
        return None
    if isinstance(parsed.get('cookies'), list):
        return None  # 那是 {cookies:[...]} 形状，归 json-object
    entries = list(parsed.items())
    if not entries:
        return None
    if not all(isinstance(v, (str, int, float)) and not isinstance(v, bool)
               for _, v in entries):
        return None
    return [{'name': name, 'value': str(v)} for name, v in entries]


def convert_parsed_json(parsed):
    """已解析的 JSON → {'format', 'cookies', 'origins', 'names'} 或 None。"""
    if isinstance(parsed, list):
        conv = convert_raw_cookies(parsed, [])
        return {'format': 'json-array', 'cookies': conv['cookies'],
                'origins': conv['origins'], 'names': conv['names']}
    if isinstance(parsed, dict):
        if isinstance(parsed.get('cookies'), list):
            conv = convert_raw_cookies(parsed['cookies'], parsed.get('origins'))
            return {'format': 'json-object', 'cookies': conv['cookies'],
                    'origins': conv['origins'], 'names': conv['names']}
        dict_cookies = try_dict_cookies(parsed)
        if dict_cookies is not None:
            conv = convert_raw_cookies(dict_cookies, [])
            return {'format': 'json-dict', 'cookies': conv['cookies'],
                    'origins': conv['origins'], 'names': conv['names']}
    return None


def _finalize_conversion(conv, fmt):
    """把一份“转换结果”收尾成体检结论：有 sessionid 就是可用（给出
    storageState），没有就带着格式信息报 missing_sessionid（只点名，不带值）。"""
    has_sid = any(c['name'] == 'sessionid' for c in conv['cookies'])
    names = sorted(set(conv['names']))[:30]
    if has_sid:
        return {
            'format': fmt,
            'cookieNames': names,
            'hasSessionid': True,
            'storageState': {'cookies': conv['cookies'], 'origins': conv['origins']},
            'detectedUsername': None,
            'error': None,
        }
    err = missing_sessionid_error()
    err.format_detected = fmt
    return {
        'format': fmt,
        'cookieNames': names,
        'hasSessionid': False,
        'storageState': None,
        'detectedUsername': None,
        'error': err,
    }


def analyze_text(text):
    """核心分析管线（已解码的文本进）：依次试 JSON（含字典）→ Base64 →
    Netscape → Cookie 头。返回 {'format', 'cookieNames', 'hasSessionid',
    'storageState', 'detectedUsername', 'error'}（detectedUsername 只在
    卖家整行胜出时有值），全程不把 cookie 的值放进任何字段
    （storageState 本身除外——那是内部使用对象）。"""
    raw = str(text or '').lstrip('\ufeff')
    if not raw.strip():
        err = SessionParseError('会话文件是空的，里面什么都没有。请确认放进来的文件没选错。',
                                code='empty')
        return {'format': 'unknown', 'cookieNames': [], 'hasSessionid': False,
                'storageState': None, 'detectedUsername': None, 'error': err}

    # 1) JSON 家族（纯 JSON / 带标签行 / 扁平字典）
    parsed = try_parse_json_text(raw)
    if parsed is not _PARSE_FAILED and parsed is not None:
        conv = convert_parsed_json(parsed)
        if conv:
            return _finalize_conversion(conv, conv['format'])
        # JSON 能解开但形状不认：继续往下试别的格式也没有意义，直接报格式不对
        err = SessionParseError(
            '会话文件格式不对：没有找到 cookies 数组。'
            '请确认导出的文件是 cookie JSON 或本工具的 .storage.json。',
            code='no_cookies_array', format_detected='json-object')
        return {'format': 'json-object', 'cookieNames': [], 'hasSessionid': False,
                'storageState': None, 'detectedUsername': None, 'error': err}

    # 2) Base64 包装（解开后回到 JSON 家族；外层格式记 base64包装）
    #    第一个能解出 cookie 数组的尾串/候选胜出；若它来自冒号切分，
    #    顺带从卖家整行里认出账号名（只有用户名，密码/邮箱不出本模块）。
    for cand in base64_candidates(raw):
        try:
            decoded = decode_base64(cand['text'])
        except Exception:
            continue
        if not decoded:
            continue
        inner = try_parse_json_text(decoded.lstrip('\ufeff'))
        if inner is _PARSE_FAILED or inner is None:
            continue
        conv = convert_parsed_json(inner)
        if conv:
            result = _finalize_conversion(conv, 'base64')
            result['detectedUsername'] = detect_seller_username(raw, cand['colonIndex'])
            return result

    # 3) Netscape cookies.txt
    netscape = try_parse_netscape(raw)
    if netscape:
        conv = convert_raw_cookies(netscape, [])
        return _finalize_conversion(conv, 'netscape')

    # 4) Cookie 头风格
    header = try_parse_cookie_header(raw)
    if header:
        conv = convert_raw_cookies(header, [])
        return _finalize_conversion(conv, 'cookie-header')

    err = SessionParseError(
        '会话文件读不了，已试过的读法都失败：纯 JSON、带标题行 JSON、Base64 包装、'
        'Netscape cookies.txt、Cookie 头。文件可能是未支持的格式，或已损坏。'
        '可以先跑 --check-cookies 看每个文件被认成什么格式，'
        '或向卖家索取纯 JSON 格式的 cookie 导出。',
        code='unparseable')
    return {'format': 'unknown', 'cookieNames': [], 'hasSessionid': False,
            'storageState': None, 'detectedUsername': None, 'error': err}


def analyze_session_buffer(buf):
    """字节 → 体检结论（先过编码层再进分析管线）。"""
    if buf is None:
        data = b''
    elif isinstance(buf, (bytes, bytearray)):
        data = bytes(buf)
    else:
        data = str(buf).encode('utf-8')
    decoded = decode_buffer_text(data)
    result = analyze_text(decoded['text'])
    result['encoding'] = decoded['encoding']
    return result


def parse_session_text(text):
    """从文件内容文本解析会话（抛错版）。"""
    result = analyze_text(text)
    if not result['storageState']:
        raise result['error']
    return result['storageState']


def parse_session_buffer(buf):
    """从文件字节解析会话（编码层 + 全部格式，抛错版）。"""
    result = analyze_session_buffer(buf)
    if not result['storageState']:
        raise result['error']
    return result['storageState']


def load_session_file_detailed(file_path):
    """详细版：除了 storageState，还带回体检信息（格式、卖家整行里认出的
    账号名 detectedUsername）——自动模式靠它在开浏览器之前先过一遍
    主号黑名单预检。detectedUsername 只有用户名本身，不含密码/邮箱。"""
    try:
        with open(file_path, 'rb') as f:
            buf = f.read()
    except OSError:
        raise SessionParseError('会话文件读不到：' + str(file_path) + '（请确认路径正确）')
    result = analyze_session_buffer(buf)
    if not result['storageState']:
        raise result['error']
    return {
        'storageState': result['storageState'],
        'detectedUsername': result.get('detectedUsername'),
        'format': result['format'],
    }


def load_session_file(file_path):
    return load_session_file_detailed(file_path)['storageState']


# ---------------------------------------------------------------------------
# cookies/ 文件夹扫描与体检（移植自 JS 版 src/cookiesDir.js）
# 安全红线：返回值、日志都不包含文件内容和 cookie 的值，只报告文件名、
# 格式和原因类别。
# ---------------------------------------------------------------------------
import os

# 文件夹里随仓库分发的说明文件，不当作 cookie 候选
PLACEHOLDER_NAME = 'README-放这里.md'

# 格式代码 → 中文短名（给“像X格式但没有sessionid”这类原因拼句子用）
FORMAT_REASON_NAMES = {
    'netscape': 'Netscape',
    'cookie-header': 'Cookie头',
    'json-dict': 'JSON字典',
    'base64': 'Base64包装',
}


def reason_category(err):
    """把解析错误归成一句话类别（对外只报类别，绝不带原文/值）。"""
    code = getattr(err, 'code', None)
    if code == 'empty':
        return '空文件'
    if code == 'missing_sessionid':
        name = FORMAT_REASON_NAMES.get(getattr(err, 'format_detected', None) or '')
        if name:
            return '像' + name + '格式但没有sessionid'
        return '没有sessionid'
    if code:
        return '读不出（格式不认）'
    # 兜底（没有 code 时按文案猜）：点名 sessionid 的归没有，其余归读不出
    msg = str(err) if err else ''
    if 'sessionid' in msg:
        return '没有sessionid'
    return '读不出（格式不认）'


def scan_cookies_dir(dir_path):
    """扫描目录，返回候选文件（按文件名排序）：[{'file', 'fullPath'}]。
    只收普通文件；跳过点文件、跳过说明文件、跳过子目录；任何扩展名都收。
    目录不存在/读不了时返回空数组。"""
    try:
        entries = list(os.scandir(dir_path))
    except OSError:
        return []
    names = []
    for e in entries:
        try:
            if not e.is_file():
                continue
        except OSError:
            continue
        if e.name.startswith('.'):
            continue
        if e.name == PLACEHOLDER_NAME:
            continue
        names.append(e.name)
    names.sort()
    return [{'file': n, 'fullPath': os.path.join(dir_path, n)} for n in names]


def load_candidates(dir_path):
    """逐个候选读字节并解析：能解出带 sessionid 的进 parseable（保持文件名
    排序，可带 detectedUsername 供黑名单预检）；解不出的进 unparseable，
    只留 {'file', 'reason'}。返回 {'parseable': [...], 'unparseable': [...]}。"""
    parseable = []
    unparseable = []
    for cand in scan_cookies_dir(dir_path):
        try:
            with open(cand['fullPath'], 'rb') as f:
                buf = f.read()
        except OSError:
            unparseable.append({'file': cand['file'], 'reason': '读不出（格式不认）'})
            continue
        a = analyze_session_buffer(buf)
        if a['storageState']:
            parseable.append({
                'file': cand['file'],
                'fullPath': cand['fullPath'],
                'storageState': a['storageState'],
                'detectedUsername': a.get('detectedUsername'),
            })
        else:
            unparseable.append({'file': cand['file'], 'reason': reason_category(a['error'])})
    return {'parseable': parseable, 'unparseable': unparseable}


def diagnose_file(full_path, label=None):
    """体检单个文件（--check-cookies 用）：只返回可以安全打印的东西——
    文件名、格式中文名、cookie 名字清单、是否有 sessionid、结论和原因
    类别，以及卖家整行认出的账号名 detectedUsername（只有用户名）。
    绝不返回任何 cookie 的值、密码或邮箱。文件读不到按不可用处理，不抛错。"""
    shown = label or os.path.basename(full_path)
    try:
        with open(full_path, 'rb') as f:
            buf = f.read()
    except OSError:
        return {'file': shown, 'format': '未知', 'cookieNames': [],
                'hasSessionid': False, 'detectedUsername': None,
                'ok': False, 'reason': '读不出（格式不认）'}
    a = analyze_session_buffer(buf)
    return {
        'file': shown,
        'format': FORMAT_LABELS.get(a['format'], '未知'),
        'cookieNames': a.get('cookieNames') or [],
        'hasSessionid': bool(a.get('hasSessionid')),
        'detectedUsername': a.get('detectedUsername'),
        'ok': bool(a['storageState']),
        'reason': '' if a['storageState'] else reason_category(a['error']),
    }
