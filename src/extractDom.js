'use strict';
// DOM 优先提取模块。
//
// 背景（现场实测）：登录版 IG 帖子页上，旧的内嵌 JSON / og 读法经常拿不到
// 作者和评论（owner=未知、评论 0），但人眼在页面上明明能看到评论人。
// 所以改成“像人一样读可见 DOM”：
// - harvestPostDomInPage / scrollCommentsInPage / navProfileUsernameInPage
//   是在页面里执行的函数（page.evaluate 会把函数序列化后送进页面，因此
//   必须自包含：只用 document 全局和最基础的 DOM API——querySelector(All)
//   的标签选择器、getAttribute、textContent、parentElement、children、
//   scrollHeight/clientHeight/scrollTop），负责把页面结构读成纯数据快照。
//   测试里用一个手写假 DOM 实现同一组 API，就能直接跑这三个函数。
// - 其余是 Node 侧纯函数：从快照里挑作者、洗评论行、去重、与旧 JSON
//   结果合并。原则不变：拿不到给空/null，绝不编造。

const extract = require('./extract');

// IG 路径里不是用户名的保留段（单段路径 /<seg>/ 命中这些一律不算用户名）
const RESERVED_SEGMENTS = new Set([
  'p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'direct', 'tv',
  'about', 'legal', 'privacy', 'terms', 'help', 'session', 'challenge',
  'auth_platform', 'graphql', 'api', 'web', 'static', 'developer', 'blog',
]);

// 从 href 里抠 /<username>/ 形式的用户名；不是单段资料路径就返回 null
function usernameFromProfileHref(href) {
  if (!href) return null;
  const m = String(href).match(/^(?:[a-z]+:\/\/[^/?#]+)?(\/[^?#]*)/i);
  const p = m ? m[1] : String(href);
  const mm = p.match(/^\/([A-Za-z0-9._]+)\/?$/);
  if (!mm) return null;
  if (RESERVED_SEGMENTS.has(mm[1].toLowerCase())) return null;
  return mm[1];
}

// ================= 页面内执行（自包含，勿引用模块作用域） =================

// 把帖子页的可见结构读成快照：
// { title, headerUsernames[], rows[{username, segments[], datetime}],
//   counts{anchorsTotal, profileAnchors, commentRowCandidates},
//   hasCommentsContainer, navProfileUsername }
// 同时把评论列容器记在 document.__igcCommentsEl 上，供滚动函数复用。
function harvestPostDomInPage() {
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
    // 没有 li 结构：按“container 直接子行”给资料锚点分组
    var anchors = profileAnchorsIn(container);
    for (var k = 0; k < anchors.length; k++) {
      var n = anchors[k];
      while (n && n.parentElement && n.parentElement !== container) n = n.parentElement;
      if (n && n.parentElement === container) push(n);
    }
    return rows;
  }
  function findCommentsContainer(scope) {
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
      if (!isRoot && el.tagName === 'LI') return; // 嵌套回复行单独成行，父行不吞它的文本
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
    // 兜底候选：行内最长的 SPAN 全文（评论文本里带 @提及/话题时，叶子切分会丢正文，
    // 整段文本往往挂在一个 span 上）
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
  if (container) {
    var rowEls = rowElementsIn(container);
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

  // 作者候选（页头）：优先 <header> 里的资料锚点；没有 header 元素时，
  // 用评论区之前、评论区之外的资料锚点里最靠后的一个（桌面版作者块常是
  // 普通 div，紧贴评论区上方；媒体上的被标记用户锚点离得更远，不取）。
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

  return {
    title: doc.title || '',
    headerUsernames: headerUsernames,
    rows: rows,
    counts: {
      anchorsTotal: all(doc, 'a').length,
      profileAnchors: profileAnchorsIn(scope).length,
      commentRowCandidates: rows.length,
    },
    hasCommentsContainer: !!container,
    navProfileUsername: navUsername(),
  };
}

// 把 harvest 时标记的评论列滚到底；标记丢了（页面重渲染）就重新找一次。
// 返回 { found, scrolled, scrollHeight }（只有结构信息）。
function scrollCommentsInPage() {
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
}

// 左侧导航里的本人资料锚点用户名（带头像图或 aria-label 含 Profile）。
// 只给“尽力识别登录用户名”当一条兜底策略，读不到返回 null。
function navProfileUsernameInPage() {
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
}

// ================= Node 侧纯函数 =================

// 纯 UI 文本（不是评论内容）：点赞/回复按钮、展开回复、时间、计数、日期等
function isUiOnlyText(text) {
  const t = String(text || '').trim().replace(/[·•]+$/, '').trim();
  if (!t) return true;
  if (/^(like|reply|view replies|hide replies|view more comments?|view all comments|see translation|edited|follow|following)$/i.test(t)) return true;
  if (/^(view|hide)(\s+all)?\s+\d*\s*replies$/i.test(t)) return true;
  if (/^\d+\s*(s|m|h|d|w)$/i.test(t)) return true; // 3h / 2d / 1w
  if (/^\d+\s*(秒|分钟|小时|天|周|个月|年)(前)?$/.test(t)) return true;
  if (/^(点赞|回复|查看回复|隐藏回复|查看全部评论|查看翻译|已编辑|关注|已关注)$/.test(t)) return true;
  if (/^查看(全部)?\s*\d*\s*条回复$/.test(t)) return true;
  if (/^\d[\d,.]*\s*[kKmM]?$/.test(t)) return true; // 纯数字/计数
  if (/^\d[\d,.]*\s*(likes?|次点赞)$/i.test(t)) return true;
  if (/^\d{4}-\d{1,2}-\d{1,2}([ t]\d{1,2}:\d{2}(:\d{2})?)?$/.test(t)) return true; // 日期
  return false;
}

// 从一行评论的文本片段里挑真正的评论正文：去掉用户名本身、UI 片段、
// 时间/计数片段，剩下的取最长一段。“用户名 正文”粘在一起的片段先剥用户名。
function commentTextFromSegments(segments, username) {
  const uname = String(username || '');
  let best = '';
  const seen = new Set();
  for (const raw of segments || []) {
    let t = String(raw || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    if (uname) {
      if (t === uname || t === '@' + uname) continue;
      if (t.startsWith(uname + ' ')) t = t.slice(uname.length + 1).trim();
      else if (t.startsWith('@' + uname + ' ')) t = t.slice(uname.length + 2).trim();
    }
    if (!t || isUiOnlyText(t)) continue;
    if (t.length > best.length) best = t;
  }
  return best;
}

// 快照行 -> 统一评论形状（extract.normalizeComment）：无正文的行丢弃，
// 按 用户名|正文 去重，保留页面顺序，按 cap 截断。
// 作者本人的行（文案行/自回复）在这一层保留，下游商家筛选再剔。
function rowsToComments(rows, postUrl, cap) {
  const limit = cap && cap > 0 ? cap : 50;
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const username = String((row && row.username) || '').trim();
    if (!username) continue;
    const text = commentTextFromSegments(row.segments, username);
    if (!text) continue;
    const key = username + '|' + text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(extract.normalizeComment({
      text: text,
      ownerUsername: username,
      timestamp: row.datetime ? (extract.toIso(row.datetime) || row.datetime) : null,
      postUrl: postUrl || '',
    }));
    if (out.length >= limit) break;
  }
  return out;
}

// 一份快照的分析结果：页头作者、文案行作者与文案、洗好的评论、结构计数。
function analyzeSnapshot(snapshot, postUrl, cap) {
  const snap = snapshot || {};
  const rows = Array.isArray(snap.rows) ? snap.rows : [];
  const headerUsernames = Array.isArray(snap.headerUsernames) ? snap.headerUsernames : [];
  const first = rows[0] || null;
  const counts = snap.counts || {};
  return {
    headerOwner: headerUsernames[0] || '',
    captionAuthor: first ? String(first.username || '') : '',
    captionText: first ? commentTextFromSegments(first.segments, first.username) : '',
    comments: rowsToComments(rows, postUrl, cap),
    rawRowCount: rows.length,
    counts: {
      anchorsTotal: counts.anchorsTotal || 0,
      profileAnchors: counts.profileAnchors || 0,
      commentRowCandidates: counts.commentRowCandidates || 0,
    },
    hasCommentsContainer: !!snap.hasCommentsContainer,
    navProfileUsername: snap.navProfileUsername || null,
  };
}

// 作者判定顺序（写死）：DOM 页头锚点 → 旧内嵌 JSON/og 的作者 → 文案行作者。
// 绝不拿评论人当作者：评论行作者只有在前两路都没有时、且它就是文案行
// （评论列表第一行）时才用。
function pickOwnerUsername(sources) {
  const s = sources || {};
  for (const v of [s.headerOwner, s.payloadOwner, s.captionAuthor]) {
    const u = String(v || '').trim().replace(/^@+/, '');
    if (u) return u;
  }
  return '';
}

// 评论合并：主来源（可见 DOM）在前，次来源（旧内嵌 JSON）补缺，
// 按 用户名|正文 去重，按 cap 截断。
function mergeComments(primary, secondary, cap) {
  const limit = cap && cap > 0 ? cap : 50;
  const out = [];
  const seen = new Set();
  for (const c of [].concat(primary || [], secondary || [])) {
    if (!c || (!c.text && !c.ownerUsername)) continue;
    const key = (c.ownerUsername || '') + '|' + (c.text || '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

// 帖子调试证据的触发条件：作者没读出来且评论 0 条
function needsPostDebug(post, comments) {
  return !!post && !post.ownerUsername && (!comments || comments.length === 0);
}

module.exports = {
  harvestPostDomInPage,
  scrollCommentsInPage,
  navProfileUsernameInPage,
  usernameFromProfileHref,
  isUiOnlyText,
  commentTextFromSegments,
  rowsToComments,
  analyzeSnapshot,
  pickOwnerUsername,
  mergeComments,
  needsPostDebug,
};
