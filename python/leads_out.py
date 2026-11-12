# -*- coding: utf-8 -*-
"""最终交付物：两列客户名单（用户链接 + 评论内容），别的都不要。
移植自 JS 版 src/leadsOut.js（纯函数，可单测）。

口径：
- 只收带意向类别（intentTypes 非空）的评论。
- 帖主自己评自己帖的评论不是客户线索，剔除。
- 同一个人把同一句话评在多个帖子下，只算一条（按 用户名+评论原文
  去重，保留第一次出现的顺序）。
- 空用户名/空评论的行跳过。
"""
import csv
import io


def profile_url(username):
    return 'https://www.instagram.com/' + username + '/'


def build_leads_entries_all(items):
    """全量版（不去重）：[{username, profileUrl, comment, keyword}]。
    keyword 是这条评论所在帖子的 keyword 字段（没标时为 ''）。"""
    entries = []
    for post in items if isinstance(items, list) else []:
        if not isinstance(post, dict):
            continue
        # 只看帖子条目：评论条目本身没有 latestComments，自然跳过。
        comments = post.get('latestComments')
        if not isinstance(comments, list):
            continue
        owner = str(post.get('ownerUsername') or '').strip()
        keyword = post.get('keyword') if isinstance(post.get('keyword'), str) else ''
        for c in comments:
            if not isinstance(c, dict):
                continue
            username = str(c.get('ownerUsername') or '').strip()
            text = str(c.get('text') or '')
            if not username or not text.strip():
                continue
            if not isinstance(c.get('intentTypes'), list) or not c.get('intentTypes'):
                continue
            if owner and username == owner:
                continue  # 商家自评，不是线索
            entries.append({'username': username, 'profileUrl': profile_url(username),
                            'comment': text, 'keyword': keyword})
    return entries


def build_leads_entries(items):
    """去重版：按 用户名+评论原文 折叠，保留第一次出现顺序。"""
    entries = []
    seen = set()
    for e in build_leads_entries_all(items):
        key = e['username'] + '|' + e['comment']
        if key in seen:
            continue
        seen.add(key)
        entries.append(e)
    return entries


def build_leads_rows(items):
    return [{'profileUrl': e['profileUrl'], 'comment': e['comment']}
            for e in build_leads_entries(items)]


def to_csv(rows):
    """带 UTF-8 BOM、CRLF 换行：Windows 上双击用 Excel 打开不乱码、不断行。
    转义口径与 JS 版一致：含逗号/引号/换行才加引号，内部引号翻倍。"""
    buf = io.StringIO(newline='')
    writer = csv.writer(buf, quoting=csv.QUOTE_MINIMAL, lineterminator='\r\n')
    writer.writerow(['用户链接', '评论内容'])
    for r in rows if isinstance(rows, list) else []:
        writer.writerow([r.get('profileUrl') or '', r.get('comment') or ''])
    return '\ufeff' + buf.getvalue()
