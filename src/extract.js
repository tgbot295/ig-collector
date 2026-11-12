'use strict';
// 提取模块（纯函数，可单测）：从链接列表、页面文本/JSON 数据里提取帖子与评论。
// 原则：拿不到的字段一律给 null / 空，绝不编造数字。

function extractHashtags(caption) {
  if (!caption) return [];
  const m = String(caption).match(/#([\p{L}\p{N}_]+)/gu);
  return m ? m.map((s) => s.slice(1)) : [];
}

function shortcodeFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// 从 href 列表里挑帖子/Reel 链接，按 shortcode 去重
function extractPostLinksFromHrefs(hrefs) {
  const seen = new Map();
  for (const href of hrefs || []) {
    const code = shortcodeFromUrl(href);
    if (!code || seen.has(code)) continue;
    const isReel = /\/(reel|reels)\//.test(String(href));
    seen.set(code, {
      shortCode: code,
      url: 'https://www.instagram.com/' + (isReel ? 'reel' : 'p') + '/' + code + '/',
    });
  }
  return Array.from(seen.values());
}

// "1,234" / "1.5k" / "2.3m" -> 数字；认不出返回 null
function parseCount(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().toLowerCase().replace(/,/g, '');
  const m = s.match(/([\d.]+)\s*([km])?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === 'k') n *= 1e3;
  if (m[2] === 'm') n *= 1e6;
  return Math.round(n);
}

// og:description 形如 "321 likes, 45 comments - ..." 时抠计数
function parseOgCounts(og) {
  const out = { likesCount: null, commentsCount: null };
  if (!og) return out;
  const like = String(og).match(/([\d,.]+[km]?)\s+likes?/i);
  const com = String(og).match(/([\d,.]+[km]?)\s+comments?/i);
  if (like) out.likesCount = parseCount(like[1]);
  if (com) out.commentsCount = parseCount(com[1]);
  return out;
}

function toIso(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// 统一评论形状（与 app 导入模块 normalizeComment 的输入字段对齐）
function normalizeComment(raw) {
  raw = raw || {};
  return {
    id: raw.id !== null && raw.id !== undefined ? String(raw.id) : null,
    text: raw.text || '',
    ownerUsername: raw.ownerUsername || '',
    ownerProfilePicUrl: raw.ownerProfilePicUrl || '',
    likesCount: typeof raw.likesCount === 'number' ? raw.likesCount : parseCount(raw.likesCount),
    timestamp: raw.timestamp || null,
    postUrl: raw.postUrl || '',
  };
}

// 在任意嵌套对象里 BFS 找帖子节点（带 shortcode/code + owner/user 的对象）
function findMediaNode(root) {
  if (!root || typeof root !== 'object') return null;
  const queue = [root];
  const seen = new Set();
  let steps = 0;
  while (queue.length && steps++ < 8000) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    const hasCode = typeof cur.shortcode === 'string' || typeof cur.code === 'string';
    const hasOwner = (cur.owner && typeof cur.owner === 'object') ||
                     (cur.user && typeof cur.user === 'object');
    const hasBody = cur.edge_media_to_caption || cur.caption !== undefined ||
                    cur.edge_media_preview_like || cur.like_count !== undefined ||
                    cur.edge_media_to_parent_comment;
    if (hasCode && hasOwner && hasBody) return cur;
    for (const k of Object.keys(cur)) {
      const v = cur[k];
      if (v && typeof v === 'object') queue.push(v);
    }
  }
  return null;
}

// 把 IG 帖子节点（GraphQL shortcode_media / items 两种常见形状）转成导入兼容形状
function mediaNodeToResult(node, postUrl) {
  if (!node || typeof node !== 'object') return null;
  const shortCode = node.shortcode || node.code || null;
  const ownerObj = node.owner || node.user || {};
  const ownerUsername = ownerObj.username || '';
  if (!shortCode && !ownerUsername) return null;

  let caption = '';
  const capEdges = node.edge_media_to_caption && node.edge_media_to_caption.edges;
  if (Array.isArray(capEdges) && capEdges[0] && capEdges[0].node) caption = capEdges[0].node.text || '';
  if (!caption && node.caption && typeof node.caption === 'object') caption = node.caption.text || '';
  if (!caption && typeof node.caption === 'string') caption = node.caption;

  const likesRaw = node.edge_media_preview_like ? node.edge_media_preview_like.count : node.like_count;
  const commentsRaw =
    node.edge_media_to_parent_comment ? node.edge_media_to_parent_comment.count :
    node.edge_media_to_comment ? node.edge_media_to_comment.count :
    node.comment_count;
  const tsRaw = node.taken_at_timestamp !== undefined ? node.taken_at_timestamp : node.taken_at;
  const url = postUrl || (shortCode ? 'https://www.instagram.com/p/' + shortCode + '/' : null);

  const post = {
    id: node.id !== null && node.id !== undefined ? String(node.id) : (node.pk ? String(node.pk) : null),
    shortCode: shortCode,
    type: node.is_video ? 'Video' : 'Image',
    caption: caption,
    hashtags: extractHashtags(caption),
    mentions: [],
    url: url,
    likesCount: typeof likesRaw === 'number' ? likesRaw : parseCount(likesRaw),
    commentsCount: typeof commentsRaw === 'number' ? commentsRaw : parseCount(commentsRaw),
    timestamp: toIso(tsRaw),
    displayUrl: node.display_url ||
      (node.image_versions2 && Array.isArray(node.image_versions2.candidates) &&
       node.image_versions2.candidates[0] ? node.image_versions2.candidates[0].url : '') || '',
    videoUrl: node.video_url || '',
    ownerUsername: ownerUsername,
    ownerFullName: ownerObj.full_name || '',
  };

  const comments = [];
  const cEdges =
    (node.edge_media_to_parent_comment && node.edge_media_to_parent_comment.edges) ||
    (node.edge_media_to_comment && node.edge_media_to_comment.edges);
  if (Array.isArray(cEdges)) {
    for (const e of cEdges) {
      const n = e && e.node;
      if (!n) continue;
      comments.push(normalizeComment({
        id: n.id,
        text: n.text,
        ownerUsername: n.owner && n.owner.username,
        timestamp: toIso(n.created_at),
        postUrl: url,
        likesCount: n.edge_liked_by ? n.edge_liked_by.count : null,
      }));
    }
  }
  if (Array.isArray(node.comments)) {
    for (const c of node.comments) {
      if (!c) continue;
      comments.push(normalizeComment({
        id: c.id || c.pk,
        text: c.text,
        ownerUsername: c.user && c.user.username,
        timestamp: toIso(c.created_at),
        postUrl: url,
        likesCount: c.like_count,
      }));
    }
  }
  return { post: post, comments: comments.filter((c) => c.text || c.ownerUsername) };
}

function extractPostFromPayload(payload, postUrl) {
  const node = findMediaNode(payload);
  return node ? mediaNodeToResult(node, postUrl) : null;
}

// 从 text 里某位置开始抠出一个花括号平衡的 JSON 对象（跳过字符串内部）
function extractBalancedJson(text, fromIdx) {
  const start = text.indexOf('{', fromIdx);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// 从整页文本（HTML 里嵌的 JSON 等）里提取帖子：先整段 JSON 解析，再按关键key定位
function extractPostFromText(text, postUrl) {
  if (!text) return null;
  const s = String(text);
  try {
    const parsed = JSON.parse(s);
    const r = extractPostFromPayload(parsed, postUrl);
    if (r) return r;
  } catch (_) { /* 不是纯 JSON，继续按片段找 */ }

  const keys = ['"shortcode_media"', '"xdt_shortcode_media"'];
  for (const key of keys) {
    const idx = s.indexOf(key);
    if (idx < 0) continue;
    const chunk = extractBalancedJson(s, idx);
    if (!chunk) continue;
    try {
      const node = JSON.parse(chunk);
      const r = mediaNodeToResult(node, postUrl) || extractPostFromPayload(node, postUrl);
      if (r) return r;
    } catch (_) { /* 继续下一个 key */ }
  }
  // 兜底：被转义过的 JSON（\"shortcode\"）先反转义再找一次
  if (s.includes('\\"shortcode\\"')) {
    const unescaped = s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (unescaped !== s) return extractPostFromText(unescaped, postUrl);
  }
  return null;
}

module.exports = {
  extractHashtags,
  shortcodeFromUrl,
  extractPostLinksFromHrefs,
  parseCount,
  parseOgCounts,
  toIso,
  normalizeComment,
  findMediaNode,
  mediaNodeToResult,
  extractPostFromPayload,
  extractPostFromText,
};
