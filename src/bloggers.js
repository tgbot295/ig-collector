'use strict';
// 博主模式纯函数 + 资料页页面内读取函数。
//
// 博主模式的思路（用户 2026-11-12 拍板）：先按关键词找“卖货博主”
// （商家 + 粉丝量够多），再只采这些博主帖子下面的意向评论，比在话题页
// 上乱点帖子精准。本文件负责中间的博主评估：
// - parseFollowerCount：把页面上读到的粉丝文本（"1,234" / "12.3K" /
//   "1.2M" / "3.5万" 等）换成数字，认不出给 null（绝不编造）。
// - evaluateProfileCandidate：把资料页读到的原始数据收拾成候选记录
//   { username, followers, merchant, signals }；商家判定 = 资料页明确
//   标了商家号（isBusiness），或者 简介/文案 命中 filters 的售卖信号
//   （与商家帖判定同一张信号表，口径全工具一致）。
// - selectBloggers：只留 商家 && 粉丝数已知 && 粉丝 >= 门槛 的，按粉丝
//   从多到少排，取前 N 个。粉丝数读不到（null）一律不入选——用户要的
//   是“粉丝量比较多”，必须是证得到的数。
// - harvestProfileInPage：在资料页里执行的读取函数（page.evaluate 会
//   把它序列化送进页面，必须自包含：只用 document 全局和基础 DOM API）。
//   粉丝数优先取页面内嵌 JSON 的 edge_followed_by.count，拿不到再退回
//   粉丝链接的可见文本/title。读不到就给 null，不编造。

const filters = require('./filters');

// "1,234" / "12.3K" / "1.2M" / "3.5万" / "12.3K followers" -> 数字；
// 认不出返回 null。数字输入直接取整。
function parseFollowerCount(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  const s = String(v).trim();
  if (!s) return null;
  // 中文万/亿
  let m = s.match(/([\d,.]+)\s*([万亿])/);
  if (m) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    return Math.round(n * (m[2] === '万' ? 1e4 : 1e8));
  }
  // K/M/B 后缀（大小写都认）
  m = s.match(/([\d,.]+)\s*([kKmMbB])/);
  if (m) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()];
    return Math.round(n * mult);
  }
  // 纯数字（可带千分逗号/小数）
  m = s.match(/([\d,]+(?:\.\d+)?)/);
  if (m) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

// 粉丝数显示：一万以上用“万”（一位小数，去掉末尾 .0），一万以下带
// 千分逗号；未知给“未知”。给“选中博主”那行日志用，看着省事。
function formatFollowers(n) {
  if (n === null || n === undefined) return '未知';
  const num = Number(n);
  if (!Number.isFinite(num)) return '未知';
  const v = Math.round(num);
  if (v >= 10000) {
    const w = Math.round((v / 10000) * 10) / 10;
    return (Number.isInteger(w) ? String(w) : w.toFixed(1)) + '万';
  }
  return v.toLocaleString('en-US');
}

// 千分逗号（候选表里给精确数用）；未知给“未知”。
function formatFollowersFull(n) {
  if (n === null || n === undefined) return '未知';
  const num = Number(n);
  if (!Number.isFinite(num)) return '未知';
  return Math.round(num).toLocaleString('en-US');
}

// 把资料页读到的原始数据收拾成候选记录。input：
// { username, followers(number|string|null), isBusiness, category,
//   bio, captions: [文案…] }（captions 是找候选时顺手记下的这个人的文案，
//   给商家判定补信号用）。输出：
// { username, followers, merchant, signals, isBusiness, category, bio }
function evaluateProfileCandidate(input) {
  const u = input || {};
  const username = String(u.username || '').trim().replace(/^@+/, '');
  let followers = null;
  if (typeof u.followers === 'number') {
    followers = Number.isFinite(u.followers) ? Math.round(u.followers) : null;
  } else if (u.followers !== null && u.followers !== undefined && u.followers !== '') {
    followers = parseFollowerCount(u.followers);
  }
  const bio = String(u.bio || '');
  const captions = Array.isArray(u.captions) ? u.captions.map((c) => String(c || '')) : [];
  // 商家信号：简介 + 这个人的文案一起过同一张售卖信号表（与商家帖判定同口径）
  const signals = filters.merchantSignalsOf([bio].concat(captions).join('\n'));
  const isBusiness = u.isBusiness === true;
  return {
    username: username,
    followers: followers,
    merchant: isBusiness || signals.length > 0,
    signals: signals,
    isBusiness: isBusiness,
    category: typeof u.category === 'string' && u.category ? u.category : null,
    bio: bio,
  };
}

// 从候选里选博主：只留 merchant && 粉丝已知 && 粉丝 >= minFollowers，
// 按粉丝从多到少排（同粉丝数保持原顺序），取前 topN。
function selectBloggers(candidates, opts) {
  const o = opts || {};
  const min = Number.isFinite(Number(o.minFollowers)) && o.minFollowers !== null && o.minFollowers !== undefined
    ? Number(o.minFollowers) : 10000;
  const topN = Number.isFinite(Number(o.topN)) && o.topN !== null && o.topN !== undefined
    ? Math.max(1, Math.floor(Number(o.topN))) : 5;
  const list = (Array.isArray(candidates) ? candidates : [])
    .map((c, i) => ({ c: c, i: i }))
    .filter((x) => x.c && x.c.merchant === true &&
      typeof x.c.followers === 'number' && Number.isFinite(x.c.followers) &&
      x.c.followers >= min)
    .sort((a, b) => (b.c.followers - a.c.followers) || (a.i - b.i))
    .map((x) => x.c)
    .slice(0, topN);
  return list;
}

// ================= 页面内执行（自包含，勿引用模块作用域） =================

// 在博主资料页里读：粉丝数、是否商家号、类目、简介。
// profileUsername 由调用方传入（我们就是冲着这个人来的）。
// 粉丝数：先翻 <script type="application/json"> 内嵌数据找带
// edge_followed_by 的用户节点；找不到再读粉丝链接的可见文本/title
// （IG 把精确数放在 title 里，页面显示的是 12.3K 这种缩写）。
// 简介：优先内嵌 JSON 的 biography，其次 meta description 里
// “N Followers, M Following, K Posts - 后面那段”（尽力而为，拿不到给 null）。
function harvestProfileInPage(profileUsername) {
  var doc = document;
  function parseCountText(s) {
    if (s === null || s === undefined) return null;
    var str = String(s).trim();
    if (!str) return null;
    var m = str.match(/([\d,.]+)\s*([万亿])/);
    if (m) {
      var n1 = parseFloat(m[1].replace(/,/g, ''));
      if (!isFinite(n1)) return null;
      return Math.round(n1 * (m[2] === '万' ? 1e4 : 1e8));
    }
    m = str.match(/([\d,.]+)\s*([kKmMbB])/);
    if (m) {
      var n2 = parseFloat(m[1].replace(/,/g, ''));
      if (!isFinite(n2)) return null;
      var mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()];
      return Math.round(n2 * mult);
    }
    m = str.match(/([\d,]+(?:\.\d+)?)/);
    if (m) {
      var n3 = parseFloat(m[1].replace(/,/g, ''));
      return isFinite(n3) ? Math.round(n3) : null;
    }
    return null;
  }
  function findUserNode(root) {
    // BFS 找带粉丝边/商家标记/简介的用户节点
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

  var followers = null;
  var isBusiness = null;
  var category = null;
  var bio = null;

  // 1) 内嵌 JSON
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
      followers = node.edge_followed_by.count;
    }
    if (node.is_business_account !== undefined && node.is_business_account !== null) {
      isBusiness = !!node.is_business_account;
    }
    if (typeof node.category_name === 'string' && node.category_name) category = node.category_name;
    if (typeof node.biography === 'string' && node.biography) bio = node.biography;
    if (followers !== null && bio) break;
  }

  // 2) 粉丝链接文本/title 兜底
  if (followers === null) {
    var links = [];
    try { links = all(doc, 'a[href]'); } catch (e) { /* 忽略 */ }
    for (var j = 0; j < links.length; j++) {
      var href = links[j].getAttribute('href') || '';
      if (href.indexOf('/followers') < 0) continue;
      var candidates = [];
      var t = (links[j].textContent || '').trim();
      if (t) candidates.push(t);
      var lt = links[j].getAttribute('title');
      if (lt) candidates.push(lt);
      var spans = links[j].querySelectorAll ? links[j].querySelectorAll('span[title]') : [];
      for (var s2 = 0; s2 < spans.length; s2++) {
        var ti = spans[s2].getAttribute('title');
        if (ti) candidates.push(ti);
      }
      for (var c = 0; c < candidates.length; c++) {
        var n = parseCountText(candidates[c]);
        if (n !== null) { followers = n; break; }
      }
      if (followers !== null) break;
    }
  }

  // 3) 简介兜底：meta description
  if (!bio) {
    var meta = null;
    try { meta = doc.querySelector('meta[name="description"]'); } catch (e) { /* 忽略 */ }
    var desc = meta ? (meta.getAttribute('content') || '') : '';
    if (desc) {
      var mm = desc.match(/^[\d,.]+[KM万]?\s*Followers?,\s*[\d,.]+[KM万]?\s*Following?,\s*[\d,.]+[KM万]?\s*Posts?\s*-\s*(.*)$/i);
      bio = mm ? mm[1] : null;
    }
  }

  return {
    username: profileUsername || '',
    followers: followers,
    isBusiness: isBusiness,
    category: category,
    bio: bio,
  };
}

module.exports = {
  parseFollowerCount,
  formatFollowers,
  formatFollowersFull,
  evaluateProfileCandidate,
  selectBloggers,
  harvestProfileInPage,
};
