# -*- coding: utf-8 -*-
"""博主模式纯函数（不 import playwright，可单测）。移植自 JS 版
src/bloggers.js 的纯逻辑部分；页面内读取在 extract.py。

博主模式思路：先按关键词找“卖货博主”（商家 + 粉丝量够多），再只采这些
博主帖子下面的意向评论。本文件负责中间的博主评估：
- parse_follower_count：把粉丝文本（"1,234" / "12.3K" / "1.2M" /
  "3.5万" 等）换成数字，认不出给 None（绝不编造）。
- parse_followers_from_meta：【实地修复】IG 资料页的 meta description
  里写着 "12,345 Followers, 56 Following, ..." —— 这是最稳的粉丝数
  来源，博主评估时第一优先用它（JS 版没用它、只靠内嵌 JSON 和链接
  文本，实地跑出过“粉丝 未知”）。认不出给 None。
- evaluate_profile_candidate：把资料页读到的原始数据收拾成候选记录
  {username, followers, merchant, signals}；商家判定 = 资料页明确标了
  商家号（isBusiness），或者 简介/文案 命中 filters 的售卖信号。
- select_bloggers：只留 商家 && 粉丝数已知 && 粉丝 >= 门槛 的，按粉丝
  从多到少排，取前 N 个。粉丝数读不到（None）一律不入选——要的是
  “粉丝量比较多”，必须是证得到的数。
"""
import math
import re

import filters


def _js_parse_float(s):
    """模拟 JS parseFloat：取开头的数字前缀，取不到返回 NaN。"""
    m = re.match(r'^[+-]?(\d+\.?\d*|\.\d+)', str(s))
    if not m:
        return float('nan')
    try:
        return float(m.group(1))
    except ValueError:
        return float('nan')


def parse_follower_count(v):
    """"1,234" / "12.3K" / "1.2M" / "3.5万" / "12.3K followers" -> 数字；
    认不出返回 None。数字输入直接取整。"""
    if v is None:
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return int(round(v)) if math.isfinite(v) else None
    s = str(v).strip()
    if not s:
        return None
    # 中文万/亿
    m = re.search(r'([\d,.]+)\s*([万亿])', s)
    if m:
        n = _js_parse_float(m.group(1).replace(',', ''))
        if not math.isfinite(n):
            return None
        return int(round(n * (1e4 if m.group(2) == '万' else 1e8)))
    # K/M/B 后缀（大小写都认）
    m = re.search(r'([\d,.]+)\s*([kKmMbB])', s)
    if m:
        n = _js_parse_float(m.group(1).replace(',', ''))
        if not math.isfinite(n):
            return None
        mult = {'k': 1e3, 'm': 1e6, 'b': 1e9}[m.group(2).lower()]
        return int(round(n * mult))
    # 纯数字（可带千分逗号/小数）
    m = re.search(r'([\d,]+(?:\.\d+)?)', s)
    if m:
        n = _js_parse_float(m.group(1).replace(',', ''))
        return int(round(n)) if math.isfinite(n) else None
    return None


def parse_followers_from_meta(description):
    """从资料页 meta description 里抠粉丝数（博主评估的第一优先来源）。

    典型形状："12,345 Followers, 56 Following, 789 Posts - See Instagram
    photos and videos from ..."；中文界面："37.2万粉丝"。
    认不出返回 None，绝不编造。
    """
    if not description:
        return None
    s = str(description)
    m = re.search(r'([\d.,]+\s*[KMB万亿]?)\s*Followers', s, re.I)
    if m:
        n = parse_follower_count(m.group(1))
        if n is not None:
            return n
    m = re.search(r'([\d.,]+\s*[万亿]?)\s*粉丝', s)
    if m:
        n = parse_follower_count(m.group(1))
        if n is not None:
            return n
    return None


def parse_bio_from_meta(description):
    """meta description 里 “N Followers, M Following, K Posts - ” 后面那段
    当简介兜底；形状对不上返回 None。"""
    if not description:
        return None
    m = re.match(r'^[\d,.]+[KM万亿]?\s*Followers?,\s*[\d,.]+[KM万亿]?\s*Following?,\s*'
                 r'[\d,.]+[KM万亿]?\s*Posts?\s*-\s*(.*)$',
                 str(description), re.I | re.S)
    return m.group(1) if m else None


def format_followers(n):
    """粉丝数显示：一万以上用“万”（一位小数，去掉末尾 .0），一万以下带
    千分逗号；未知给“未知”。"""
    if n is None:
        return '未知'
    try:
        num = float(n)
    except (TypeError, ValueError):
        return '未知'
    if not math.isfinite(num):
        return '未知'
    v = int(round(num))
    if v >= 10000:
        w = round(v / 10000 * 10) / 10
        return (str(int(w)) if float(w).is_integer() else '%.1f' % w) + '万'
    return format(v, ',')


def format_followers_full(n):
    """千分逗号（候选表里给精确数用）；未知给“未知”。"""
    if n is None:
        return '未知'
    try:
        num = float(n)
    except (TypeError, ValueError):
        return '未知'
    if not math.isfinite(num):
        return '未知'
    return format(int(round(num)), ',')


def evaluate_profile_candidate(data=None):
    """把资料页读到的原始数据收拾成候选记录。输入：
    {username, followers(number|str|None), isBusiness, category,
     bio, captions: [文案…]}。输出：
    {username, followers, merchant, signals, isBusiness, category, bio}"""
    u = data or {}
    username = re.sub(r'^@+', '', str(u.get('username') or '').strip())
    followers = None
    f = u.get('followers')
    if isinstance(f, (int, float)) and not isinstance(f, bool):
        followers = int(round(f)) if math.isfinite(f) else None
    elif f is not None and f != '':
        followers = parse_follower_count(f)
    bio = str(u.get('bio') or '')
    captions = [str(c or '') for c in u.get('captions')] if isinstance(u.get('captions'), list) else []
    # 商家信号：简介 + 这个人的文案一起过同一张售卖信号表（与商家帖判定同口径）
    signals = filters.merchant_signals_of('\n'.join([bio] + captions))
    is_business = u.get('isBusiness') is True
    return {
        'username': username,
        'followers': followers,
        'merchant': is_business or len(signals) > 0,
        'signals': signals,
        'isBusiness': is_business,
        'category': u.get('category') if isinstance(u.get('category'), str) and u.get('category') else None,
        'bio': bio,
    }


def select_bloggers(candidates, opts=None):
    """从候选里选博主：只留 merchant && 粉丝已知 && 粉丝 >= minFollowers，
    按粉丝从多到少排（同粉丝数保持原顺序），取前 topN。"""
    o = opts or {}
    min_f = o.get('minFollowers')
    min_f = float(min_f) if isinstance(min_f, (int, float)) and not isinstance(min_f, bool) \
        and math.isfinite(min_f) else 10000
    top_n_raw = o.get('topN')
    top_n = max(1, math.floor(float(top_n_raw))) if isinstance(top_n_raw, (int, float)) \
        and not isinstance(top_n_raw, bool) and math.isfinite(top_n_raw) else 5
    indexed = [(c, i) for i, c in enumerate(candidates if isinstance(candidates, list) else [])]
    picked = [x for x in indexed
              if x[0] and x[0].get('merchant') is True
              and isinstance(x[0].get('followers'), (int, float))
              and not isinstance(x[0].get('followers'), bool)
              and math.isfinite(x[0]['followers'])
              and x[0]['followers'] >= min_f]
    picked.sort(key=lambda x: (-x[0]['followers'], x[1]))
    return [c for c, _ in picked[:top_n]]
