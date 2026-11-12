'use strict';
// 最终交付物：两列客户名单（用户链接 + 评论内容），别的都不要。
// 纯函数模块：从一次运行保留下来的帖子条目（items，带 latestComments）
// 里挑意向评论，生成 [{ profileUrl, comment }]，再序列化成 CSV。
// 口径：
// - 只收带意向类别（intentTypes 非空）的评论。默认筛选模式下保留下来的
//   评论本来就全是意向评论；--keep-all 时结果里混有无意向评论，这里
//   照样剔除——名单永远是意向名单。完整记录在 collect-*.json 里，不受影响。
// - 帖主自己评自己帖的评论不是客户线索，剔除。
// - 同一个人把同一句话评在多个帖子下，只算一条（按 用户名+评论原文 去重，
//   保留第一次出现的顺序）。

function profileUrl(username) {
  return 'https://www.instagram.com/' + username + '/';
}

// 明细版（累积存储用）：[{ username, profileUrl, comment, keyword }]，
// keyword 是这条评论所在帖子的 keyword 字段（帖子条目上的标记，多关键词
// 运行时才有区分；单关键词时就是那个词，帖上没标时为 ''）。
// 筛选/去重口径与 buildLeadsRows 完全一致——buildLeadsRows 就是在它上面
// 砍掉 username/keyword 两列，全工具只此一份判定，不会两边漂移。
// 全量版（不去重）：每个帖子里每条合格评论一条 entry，带它所在帖子的
// keyword。口径（意向限定、剔除帖主自评、跳过空用户名/空评论）和去重版
// 完全一致——去重版就是在它上面按 用户名+评论 折叠。累积存储要用这个
// 版本：同一条线索在多个关键词下出现时，每个关键词都要能记进它的
// keywords 列表，先去重再合并就会把后面的关键词弄丢。
function buildLeadsEntriesAll(items) {
  const entries = [];
  const list = Array.isArray(items) ? items : [];
  for (const post of list) {
    if (!post || typeof post !== 'object') continue;
    // 只看帖子条目：评论条目本身没有 latestComments，自然跳过。
    const comments = Array.isArray(post.latestComments) ? post.latestComments : null;
    if (!comments) continue;
    const owner = String(post.ownerUsername || '').trim();
    const keyword = typeof post.keyword === 'string' ? post.keyword : '';
    for (const c of comments) {
      if (!c || typeof c !== 'object') continue;
      const username = String(c.ownerUsername || '').trim();
      const text = String(c.text || '');
      if (!username || !text.trim()) continue;
      if (!Array.isArray(c.intentTypes) || c.intentTypes.length === 0) continue;
      if (owner && username === owner) continue; // 商家自评，不是线索
      entries.push({ username: username, profileUrl: profileUrl(username), comment: text, keyword: keyword });
    }
  }
  return entries;
}

function buildLeadsEntries(items) {
  const entries = [];
  const seen = new Set();
  for (const e of buildLeadsEntriesAll(items)) {
    const key = e.username + '|' + e.comment;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(e);
  }
  return entries;
}

function buildLeadsRows(items) {
  return buildLeadsEntries(items).map((e) => ({ profileUrl: e.profileUrl, comment: e.comment }));
}

// CSV 字段转义：含逗号/引号/换行时用双引号包起来，内部引号翻倍。
function csvField(value) {
  const s = String(value == null ? '' : value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// 带 UTF-8 BOM、CRLF 换行：Windows 上双击用 Excel 打开不乱码、不断行。
function toCsv(rows) {
  const lines = ['用户链接,评论内容'];
  for (const r of Array.isArray(rows) ? rows : []) {
    lines.push(csvField(r.profileUrl) + ',' + csvField(r.comment));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n'; // 开头是 UTF-8 BOM
}

module.exports = { buildLeadsRows, buildLeadsEntries, buildLeadsEntriesAll, toCsv, profileUrl };
