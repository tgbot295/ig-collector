'use strict';
// 评论意向分类（采集端预筛）：与本地版工具 app/src/intentLeads.js 的
// INTENT_CATEGORIES 完全对齐（同一套类别、同样的中英双语关键词），
// 保证两个工具对“什么算意向评论”的判断一致。
// 类别顺序固定：问购买 → 问价格 → 问运费 → 问尺码。

const INTENT_CATEGORIES = [
  { key: 'buy', label: '问购买', patterns: [/how to buy/i, /where to buy/i, /\border\b/i, /\bbuy\b/i, /\bdm\b/i, /怎么买/, /如何购买/, /下单/, /购买/] },
  { key: 'price', label: '问价格', patterns: [/price/i, /how much/i, /\bcost\b/i, /多少钱/, /价格/, /什么价/] },
  { key: 'ship', label: '问运费', patterns: [/\bship/i, /shipping/i, /deliver/i, /运费/, /发货/, /包邮/] },
  { key: 'size', label: '问尺码', patterns: [/\bsize\b/i, /尺码/, /大小/] },
];

// 一条评论命中的意向类别名（label）数组；可多命中，没命中返回 []。
function commentIntent(text) {
  const t = String(text || '');
  return INTENT_CATEGORIES
    .filter((c) => c.patterns.some((re) => re.test(t)))
    .map((c) => c.label);
}

// 采集端评论筛选（纯函数）：给每条评论算 intentTypes 并挂回评论对象。
// keepAll=false（默认）：只保留命中意向的评论；keepAll=true：全保留，
// intentTypes 照样标好（没命中的是 []）。
// 返回 { kept, seen, intentCount }：seen=输入条数，intentCount=命中意向的条数。
function filterCommentsByIntent(comments, keepAll) {
  const list = Array.isArray(comments) ? comments : [];
  const kept = [];
  let intentCount = 0;
  for (const c of list) {
    const types = commentIntent(c && c.text);
    if (types.length > 0) intentCount++;
    if (keepAll || types.length > 0) {
      c.intentTypes = types;
      kept.push(c);
    }
  }
  return { kept: kept, seen: list.length, intentCount: intentCount };
}

module.exports = { INTENT_CATEGORIES, commentIntent, filterCommentsByIntent };
