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

function buildLeadsRows(items) {
  const rows = [];
  const seen = new Set();
  const list = Array.isArray(items) ? items : [];
  for (const post of list) {
    if (!post || typeof post !== 'object') continue;
    // 只看帖子条目：评论条目本身没有 latestComments，自然跳过。
    const comments = Array.isArray(post.latestComments) ? post.latestComments : null;
    if (!comments) continue;
    const owner = String(post.ownerUsername || '').trim();
    for (const c of comments) {
      if (!c || typeof c !== 'object') continue;
      const username = String(c.ownerUsername || '').trim();
      const text = String(c.text || '');
      if (!username || !text.trim()) continue;
      if (!Array.isArray(c.intentTypes) || c.intentTypes.length === 0) continue;
      if (owner && username === owner) continue; // 商家自评，不是线索
      const key = username + '|' + text;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ profileUrl: profileUrl(username), comment: text });
    }
  }
  return rows;
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

module.exports = { buildLeadsRows, toCsv, profileUrl };
