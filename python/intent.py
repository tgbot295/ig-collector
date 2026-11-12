# -*- coding: utf-8 -*-
"""评论意向分类（采集端预筛）。移植自 JS 版 src/intent.js，与本地版工具的
INTENT_CATEGORIES 完全对齐（同一套类别、同样的中英双语关键词），保证
各工具对“什么算意向评论”的判断一致。
类别顺序固定：问购买 → 问价格 → 问运费 → 问尺码。（纯函数，可单测）"""
import re

INTENT_CATEGORIES = [
    {'key': 'buy', 'label': '问购买',
     'patterns': [re.compile(p, re.I) for p in
                  [r'how to buy', r'where to buy', r'\border\b', r'\bbuy\b', r'\bdm\b']]
     + [re.compile(p) for p in ['怎么买', '如何购买', '下单', '购买']]},
    {'key': 'price', 'label': '问价格',
     'patterns': [re.compile(p, re.I) for p in [r'price', r'how much', r'\bcost\b']]
     + [re.compile(p) for p in ['多少钱', '价格', '什么价']]},
    {'key': 'ship', 'label': '问运费',
     'patterns': [re.compile(p, re.I) for p in [r'\bship', r'shipping', r'deliver']]
     + [re.compile(p) for p in ['运费', '发货', '包邮']]},
    {'key': 'size', 'label': '问尺码',
     'patterns': [re.compile(p, re.I) for p in [r'\bsize\b']]
     + [re.compile(p) for p in ['尺码', '大小']]},
]


def classify_comment(text):
    """一条评论命中的意向类别名（label）数组；可多命中，没命中返回 []。"""
    t = str(text or '')
    return [c['label'] for c in INTENT_CATEGORIES
            if any(p.search(t) for p in c['patterns'])]


# 与 JS 版同名口径：comment_intent = classify_comment
comment_intent = classify_comment


def filter_comments_by_intent(comments, keep_all=False):
    """采集端评论筛选（纯函数）：给每条评论算 intentTypes 并挂回评论对象。

    keep_all=False（默认）：只保留命中意向的评论；keep_all=True：全保留，
    intentTypes 照样标好（没命中的是 []）。
    返回 {'kept', 'seen', 'intentCount'}：seen=输入条数，intentCount=命中数。
    """
    lst = comments if isinstance(comments, list) else []
    kept = []
    intent_count = 0
    for c in lst:
        types = classify_comment(c.get('text') if isinstance(c, dict) else None)
        if types:
            intent_count += 1
        if keep_all or types:
            if isinstance(c, dict):
                c['intentTypes'] = types
            kept.append(c)
    return {'kept': kept, 'seen': len(lst), 'intentCount': intent_count}
