# -*- coding: utf-8 -*-
"""采集筛选的纯判定函数（可单测）：帖子新鲜度 + 商家帖文案信号。
移植自 JS 版 src/filters.js。

商家信号与本地版工具的 SELLING_SIGNALS 对齐（同样的 key/label/判定
口径），在此基础上补了：私信、商店、店铺、store、订购、批发、
wholesale、出售、wa.me。
注意：不用单个“店”字作信号——“咖啡店/书店”这类生活词会误伤路人帖；
用“商店/店铺”两个完整词，既能命中卖家文案，又避开“在这家咖啡店”。"""
import math
import re
from datetime import datetime, timezone

SELLING_SIGNALS = [
    # —— 与主工具的 SELLING_SIGNALS 逐条对齐 ——
    {'key': 'price-word', 'label': '文案含 price', 're': re.compile(r'price', re.I)},
    {'key': 'usd', 'label': '文案含 $', 're': re.compile(r'\$')},
    {'key': 'cny', 'label': '文案含 ¥', 're': re.compile('¥')},
    {'key': 'dm-to-buy', 'label': '文案含 DM to buy/order', 're': re.compile(r'\bdm\b[^.,;]{0,24}(buy|order)', re.I)},
    {'key': 'shop', 'label': '文案含 shop', 're': re.compile(r'\bshop\b', re.I)},
    {'key': 'sale', 'label': '文案含 sale', 're': re.compile(r'\bsale\b', re.I)},
    {'key': 'whatsapp', 'label': '文案含 WhatsApp', 're': re.compile(r'whatsapp', re.I)},
    {'key': 'link-in-bio', 'label': '文案含 link in bio', 're': re.compile(r'link in bio', re.I)},
    {'key': 'order', 'label': '文案含 order', 're': re.compile(r'\border\b', re.I)},
    {'key': 'goumai', 'label': '文案含 购买', 're': re.compile('购买')},
    {'key': 'jiage', 'label': '文案含 价格', 're': re.compile('价格')},
    {'key': 'xiadan', 'label': '文案含 下单', 're': re.compile('下单')},
    # —— 卖家文案常见补充信号 ——
    {'key': 'sixin', 'label': '文案含 私信', 're': re.compile('私信')},
    {'key': 'store', 'label': '文案含 store', 're': re.compile(r'\bstore\b', re.I)},
    {'key': 'shangdian', 'label': '文案含 商店', 're': re.compile('商店')},
    {'key': 'dianpu', 'label': '文案含 店铺', 're': re.compile('店铺')},
    {'key': 'dinggou', 'label': '文案含 订购', 're': re.compile('订购')},
    {'key': 'pifa', 'label': '文案含 批发', 're': re.compile('批发')},
    {'key': 'wholesale', 'label': '文案含 wholesale', 're': re.compile(r'wholesale', re.I)},
    {'key': 'chushou', 'label': '文案含 出售', 're': re.compile('出售')},
    {'key': 'wame', 'label': '文案含 wa.me', 're': re.compile(r'wa\.me', re.I)},
]


def merchant_signals_of(caption):
    """文案命中的售卖信号 label 列表（按信号表顺序）；空数组 = 非商家帖。"""
    t = str(caption or '')
    return [s['label'] for s in SELLING_SIGNALS if s['re'].search(t)]


def is_merchant_caption(caption):
    return len(merchant_signals_of(caption)) > 0


def _to_epoch_ms(v):
    """时间戳/ISO 字符串 → epoch 毫秒；认不出返回 None。"""
    if v is None or v == '':
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        n = float(v)
        if not math.isfinite(n):
            return None
        return n if n > 1e12 else n * 1000
    s = str(v).strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace('Z', '+00:00').replace('z', '+00:00'))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp() * 1000


def decide_post_age(opts=None):
    """帖子新鲜度判定（纯函数）：

    - maxAgeDays <= 0 或非法 → 不限，恒 keep；
    - timestamp 缺失/认不出 → keep（ageDays 给 None，照常采集，调用方标 unknown）；
    - ageDays = (now - 发布时间) / 天；严格大于上限才 skip（正好等于上限保留）；
      未来的时间（时钟偏差）ageDays 为负，keep。
    返回 {'action': 'keep'|'skip', 'ageDays': float|None}。
    """
    o = opts or {}
    try:
        limit = float(o.get('maxAgeDays'))
    except (TypeError, ValueError):
        limit = float('nan')
    if not math.isfinite(limit) or limit <= 0:
        return {'action': 'keep', 'ageDays': None}
    ts = _to_epoch_ms(o.get('timestamp'))
    if ts is None:
        return {'action': 'keep', 'ageDays': None}
    ref = _to_epoch_ms(o.get('now')) if o.get('now') is not None else None
    if ref is None:
        ref = datetime.now(timezone.utc).timestamp() * 1000
    age_days = (ref - ts) / 86400000
    return {'action': 'skip' if age_days > limit else 'keep', 'ageDays': age_days}
