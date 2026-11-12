'use strict';
// 累积存储（纯本地）：历次运行采到的帖子和意向客户名单攒在一个 JSON 里，
// 跨运行去重、累积。用途：
// - 帖子：话题页收集到链接后，先查这里，采过的帖子默认跳过（--rescan 例外），
//   不再每次从头重采同一批帖子。
// - 名单：每次运行的意向评论（与 leads-*.csv 同口径）合并进来，同一人同一句
//   评论只存一条；同一条线索在多个关键词下出现时，关键词会累积到它的
//   keywords 列表里。结尾再把整个累积名单导出成 leads-all-*.csv。
//
// 文件：data/store.json（已被 .gitignore 排除），权限 0600，写入走
// 临时文件 + 改名（原子替换），写一半断电也不会把文件写坏。
// 文件不存在 = 首次用，空库开始；文件损坏/格式不对 = 空库开始并标记 corrupt，
// 由调用方打一行警告，绝不因为存量数据坏了就整个工具跑不了。

const fs = require('fs');
const path = require('path');
const leadsOut = require('./leadsOut');

function emptyStore() {
  return { version: 1, posts: {}, leads: {}, updatedAt: null };
}

// 名单的去重键：用户名 + 评论原文（与 leadsOut.buildLeadsRows 同口径）。
// 用换行拼接：用户名里不可能有换行，不会和评论正文撞键。
function leadKey(username, comment) {
  return String(username || '') + '\n' + String(comment || '');
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// 把读到的 JSON 收拾成规整形状：不合规的条目丢掉，不合规的整体当空库。
function normalizeStore(data) {
  if (!isPlainObject(data)) return null;
  if (!isPlainObject(data.posts) || !isPlainObject(data.leads)) return null;
  const store = emptyStore();
  store.updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : null;
  for (const url of Object.keys(data.posts)) {
    const p = data.posts[url];
    if (!isPlainObject(p)) continue;
    store.posts[url] = {
      postUrl: typeof p.postUrl === 'string' ? p.postUrl : url,
      keyword: typeof p.keyword === 'string' ? p.keyword : '',
      checkedAt: typeof p.checkedAt === 'string' ? p.checkedAt : null,
    };
  }
  for (const key of Object.keys(data.leads)) {
    const l = data.leads[key];
    if (!isPlainObject(l) || !l.username || !l.comment) continue;
    store.leads[key] = {
      username: String(l.username),
      comment: String(l.comment),
      firstSeenAt: typeof l.firstSeenAt === 'string' ? l.firstSeenAt : null,
      keywords: Array.isArray(l.keywords) ? l.keywords.filter((k) => typeof k === 'string') : [],
    };
  }
  return store;
}

// 读存储。返回 { store, missing, corrupt }：
// missing=true 表示文件不存在（首次用，正常）；corrupt=true 表示文件在但
// 读不出/格式不对（已按空库处理，调用方应打警告）。
function loadStore(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { store: emptyStore(), missing: true, corrupt: false };
    return { store: emptyStore(), missing: false, corrupt: true };
  }
  try {
    const store = normalizeStore(JSON.parse(raw));
    if (!store) return { store: emptyStore(), missing: false, corrupt: true };
    return { store: store, missing: false, corrupt: false };
  } catch (e) {
    return { store: emptyStore(), missing: false, corrupt: true };
  }
}

// 原子写：先写同目录的 .tmp 再改名，权限 0600。
function saveStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows 上无此概念，忽略 */ }
}

// 这个帖子链接以前采过没有（帖子跳过判定就靠它）。
function hasPost(store, postUrl) {
  return !!(store && store.posts && Object.prototype.hasOwnProperty.call(store.posts, postUrl));
}

// 把一次运行的成果并进累积存储（原地改 store 对象，调用方负责 saveStore）：
// - posts: [{ postUrl, keyword, checkedAt }]，没见过的才记（第一次的关键词和
//   时间为准，重复出现不覆盖）。
// - leads: [{ username, comment, keyword }]（leadsOut.buildLeadsEntries 的
//   形状），没见过的整条新增；见过的只把新关键词补进它的 keywords 列表。
// 返回 { addedPosts, addedLeads }，供汇总打印。
function mergeRun(store, runData) {
  const d = runData || {};
  const now = typeof d.now === 'string' ? d.now : new Date().toISOString();
  let addedPosts = 0;
  let addedLeads = 0;
  for (const p of Array.isArray(d.posts) ? d.posts : []) {
    if (!p || !p.postUrl) continue;
    if (!Object.prototype.hasOwnProperty.call(store.posts, p.postUrl)) {
      store.posts[p.postUrl] = {
        postUrl: p.postUrl,
        keyword: typeof p.keyword === 'string' ? p.keyword : '',
        checkedAt: typeof p.checkedAt === 'string' ? p.checkedAt : now,
      };
      addedPosts++;
    }
  }
  for (const l of Array.isArray(d.leads) ? d.leads : []) {
    if (!l || !l.username || !l.comment) continue;
    const key = leadKey(l.username, l.comment);
    const kw = typeof l.keyword === 'string' ? l.keyword : '';
    const existing = store.leads[key];
    if (!existing) {
      store.leads[key] = {
        username: String(l.username),
        comment: String(l.comment),
        firstSeenAt: now,
        keywords: kw ? [kw] : [],
      };
      addedLeads++;
    } else if (kw && !existing.keywords.includes(kw)) {
      existing.keywords.push(kw);
    }
  }
  store.updatedAt = now;
  return { addedPosts: addedPosts, addedLeads: addedLeads };
}

// 累积名单 → leadsOut 的行形状（[{ profileUrl, comment }]，按首次出现顺序），
// 直接喂给 leadsOut.toCsv / xlsx 导出，两列 CSV 的口径全工具只有一个来源。
function leadsRows(store) {
  const leads = (store && store.leads) || {};
  return Object.keys(leads).map((key) => {
    const l = leads[key];
    return { profileUrl: leadsOut.profileUrl(l.username), comment: l.comment };
  });
}

// 统计卡用的三个数：累计帖子、累计评论线索（条）、去重用户（人）。
function statsOf(store) {
  const posts = (store && store.posts) || {};
  const leads = (store && store.leads) || {};
  const users = new Set();
  for (const key of Object.keys(leads)) users.add(leads[key].username);
  return {
    posts: Object.keys(posts).length,
    leads: Object.keys(leads).length,
    users: users.size,
  };
}

module.exports = {
  emptyStore,
  leadKey,
  loadStore,
  saveStore,
  hasPost,
  mergeRun,
  leadsRows,
  statsOf,
};
