'use strict';
// DOM 优先提取单测：不联网、不开浏览器。
// 背景：登录版 IG 帖子页上旧内嵌 JSON 读法拿到 owner=未知、评论 0，
// 但页面上明明有评论人。新读法（src/extractDom.js）读可见 DOM。
// 这里用一个手写极简假 DOM（只实现 harvest 函数用到的 API：标签选择器
// querySelector(All)、getAttribute、textContent、parentElement、children、
// scrollHeight/clientHeight/scrollTop），让页面内函数原样在 Node 里跑夹具。
const assert = require('assert');
const extractDom = require('../src/extractDom');
const extract = require('../src/extract');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

// ---------- 极简假 DOM ----------
class El {
  constructor(tag, attrs, text) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = attrs || {};
    this.ownText = text || '';
    this.children = [];
    this.parentElement = null;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.scrollTop = 0;
  }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  setAttribute(name, v) { this.attrs[name] = String(v); }
  append(...kids) {
    for (const k of kids) { k.parentElement = this; this.children.push(k); }
    return this;
  }
  get textContent() {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  querySelectorAll(tag) {
    const want = String(tag).toUpperCase();
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (c.tagName === want) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(tag) { return this.querySelectorAll(tag)[0] || null; }
}
function el(tag, attrs, text) { return new El(tag, attrs, text); }
function makeDoc(children, title) {
  const body = el('body');
  body.append(...children);
  return {
    title: title || '',
    querySelectorAll(tag) { return body.querySelectorAll(tag); },
    querySelector(tag) { return body.querySelector(tag); },
  };
}
function withDoc(doc, fn) {
  global.document = doc;
  try { return fn(); } finally { delete global.document; }
}

// 一行评论的典型结构：头像锚点 + （用户名锚点 + 正文 span） + （time + Reply）
function commentLi(username, text, datetime, timeText) {
  const li = el('li');
  const wrap = el('div');
  const avatarA = el('a', { href: '/' + username + '/' });
  avatarA.append(el('img', { alt: username + "'s profile picture" }));
  const bodyDiv = el('div');
  const line = el('div');
  line.append(el('a', { href: '/' + username + '/' }, username), el('span', {}, text));
  const meta = el('div');
  meta.append(el('time', { datetime: datetime || '' }, timeText || ''), el('span', {}, 'Reply'));
  bodyDiv.append(line, meta);
  wrap.append(avatarA, bodyDiv);
  li.append(wrap);
  return li;
}
function scrollableBox(kids) {
  const box = el('div');
  box.scrollHeight = 2400;
  box.clientHeight = 500;
  const ul = el('ul');
  ul.append(...kids);
  box.append(ul);
  return box;
}
function navWithProfile(username) {
  const nav = el('nav');
  nav.append(el('a', { href: '/explore/' }, 'Explore'));
  if (username) {
    const a = el('a', { href: '/' + username + '/' });
    a.append(el('img', { alt: username + "'s profile picture" }));
    nav.append(a);
  }
  return nav;
}

// ---------- 纯函数：href -> 用户名 ----------
ok('dom: usernameFromProfileHref', () => {
  assert.strictEqual(extractDom.usernameFromProfileHref('https://www.instagram.com/buyer_anna/'), 'buyer_anna');
  assert.strictEqual(extractDom.usernameFromProfileHref('/buyer_anna'), 'buyer_anna');
  assert.strictEqual(extractDom.usernameFromProfileHref('/p/ABC123/'), null);
  assert.strictEqual(extractDom.usernameFromProfileHref('/reel/XYZ_9/'), null);
  assert.strictEqual(extractDom.usernameFromProfileHref('/explore/tags/downjacket/'), null);
  assert.strictEqual(extractDom.usernameFromProfileHref('/accounts/edit/'), null);
  assert.strictEqual(extractDom.usernameFromProfileHref(''), null);
  assert.strictEqual(extractDom.usernameFromProfileHref(null), null);
});

// ---------- 纯函数：评论行清洗 ----------
ok('dom: rowsToComments drops UI-only rows', () => {
  const rows = [
    { username: 'u_view', segments: ['u_view', 'View replies'], datetime: null },
    { username: 'u_time', segments: ['u_time', '3h'], datetime: null },
  ];
  assert.deepStrictEqual(extractDom.rowsToComments(rows, 'https://www.instagram.com/p/X/', 50), []);
});
ok('dom: rowsToComments picks real text among UI segments', () => {
  const rows = [{ username: 'u2', segments: ['u2', '42', 'Reply', 'Nice jacket, how much?'], datetime: '2024-11-11T13:00:00.000Z' }];
  const cs = extractDom.rowsToComments(rows, 'https://www.instagram.com/p/X/', 50);
  assert.strictEqual(cs.length, 1);
  assert.strictEqual(cs[0].ownerUsername, 'u2');
  assert.strictEqual(cs[0].text, 'Nice jacket, how much?');
  assert.strictEqual(cs[0].timestamp, '2024-11-11T13:00:00.000Z');
  assert.strictEqual(cs[0].postUrl, 'https://www.instagram.com/p/X/');
});
ok('dom: rowsToComments strips glued username prefix', () => {
  const rows = [{ username: 'u3', segments: ['u3 Nice coat!'], datetime: null }];
  const cs = extractDom.rowsToComments(rows, '', 50);
  assert.strictEqual(cs.length, 1);
  assert.strictEqual(cs[0].text, 'Nice coat!');
});

// ---------- 纯函数：作者判定顺序 ----------
ok('dom: pickOwner priority header > payload > caption author', () => {
  assert.strictEqual(extractDom.pickOwnerUsername({ headerOwner: 'shop_a', payloadOwner: 'shop_b', captionAuthor: 'buyer_x' }), 'shop_a');
  assert.strictEqual(extractDom.pickOwnerUsername({ headerOwner: '', payloadOwner: 'shop_b', captionAuthor: 'buyer_x' }), 'shop_b');
  assert.strictEqual(extractDom.pickOwnerUsername({ headerOwner: '', payloadOwner: '', captionAuthor: 'buyer_x' }), 'buyer_x');
  assert.strictEqual(extractDom.pickOwnerUsername({ headerOwner: '', payloadOwner: '', captionAuthor: '' }), '');
  assert.strictEqual(extractDom.pickOwnerUsername({ headerOwner: '@shop_a' }), 'shop_a');
});

// ---------- 夹具 A：桌面双栏帖子页（页头作者 + 文案行 + 3 评论 + 1 条作者回复） ----------
const POST_URL_A = 'https://www.instagram.com/p/FIXTUREDOM1/';
function buildFixtureA() {
  const header = el('header');
  const hAvatar = el('a', { href: '/sample_down_shop/' });
  hAvatar.append(el('img', { alt: "sample_down_shop's profile picture" }));
  header.append(hAvatar, el('a', { href: '/sample_down_shop/' }, 'sample_down_shop'));

  const caption = commentLi('sample_down_shop', 'New down jacket in stock #downjacket #winter - DM to order', '2024-11-11T10:00:00.000Z', '1d');
  const c1 = commentLi('buyer_anna', 'How much is it? How to buy?', '2024-11-11T13:00:00.000Z', '3h');
  const c2 = commentLi('maple_mike', 'Do you ship to Canada?', '2024-11-11T14:00:00.000Z', '2h');
  const c3 = commentLi('ski_sam', 'What sizes do you have?', '2024-11-11T15:00:00.000Z', '1h');
  // c3 下面挂一条作者回复（嵌套 li）：父行正文不能被回复吞掉，回复自己单独成行
  const replyUl = el('ul');
  replyUl.append(commentLi('sample_down_shop', 'Sizes S to XXL', '2024-11-11T15:30:00.000Z', '44m'));
  c3.children[0].children[1].append(replyUl);

  const box = scrollableBox([caption, c1, c2, c3]);
  const rightCol = el('div');
  rightCol.append(header, box);
  const article = el('article');
  article.append(el('div'), rightCol);
  const main = el('main');
  main.append(article);
  const doc = makeDoc([navWithProfile('collector_small'), main], 'Sample Down Shop on Instagram');
  return { doc, box };
}

ok('dom: fixture A harvest structure (header, counts, container, nav)', () => {
  const { doc } = buildFixtureA();
  const snap = withDoc(doc, () => extractDom.harvestPostDomInPage());
  assert.deepStrictEqual(snap.headerUsernames, ['sample_down_shop']);
  assert.strictEqual(snap.hasCommentsContainer, true);
  assert.strictEqual(snap.counts.commentRowCandidates, 5);
  assert.strictEqual(snap.counts.anchorsTotal, 14);
  assert.strictEqual(snap.counts.profileAnchors, 12);
  assert.strictEqual(snap.navProfileUsername, 'collector_small');
  assert.strictEqual(snap.rows.length, 5);
  assert.strictEqual(snap.rows[1].username, 'buyer_anna');
  assert.strictEqual(snap.rows[1].datetime, '2024-11-11T13:00:00.000Z');
});

ok('dom: fixture A analyze (owner is shop not commenter, 5 comments, reply separate)', () => {
  const { doc } = buildFixtureA();
  const snap = withDoc(doc, () => extractDom.harvestPostDomInPage());
  const dom = extractDom.analyzeSnapshot(snap, POST_URL_A, 50);
  assert.strictEqual(dom.headerOwner, 'sample_down_shop');
  assert.strictEqual(dom.captionAuthor, 'sample_down_shop');
  assert.strictEqual(dom.captionText, 'New down jacket in stock #downjacket #winter - DM to order');
  assert.strictEqual(dom.comments.length, 5);
  assert.strictEqual(dom.comments[0].ownerUsername, 'sample_down_shop'); // 文案行保留，下游再剔
  assert.strictEqual(dom.comments[1].ownerUsername, 'buyer_anna');
  assert.strictEqual(dom.comments[1].text, 'How much is it? How to buy?');
  assert.strictEqual(dom.comments[1].timestamp, '2024-11-11T13:00:00.000Z');
  assert.strictEqual(dom.comments[1].postUrl, POST_URL_A);
  assert.strictEqual(dom.comments[2].ownerUsername, 'maple_mike');
  assert.strictEqual(dom.comments[3].ownerUsername, 'ski_sam');
  assert.strictEqual(dom.comments[3].text, 'What sizes do you have?'); // 没被嵌套回复污染
  assert.strictEqual(dom.comments[4].ownerUsername, 'sample_down_shop');
  assert.strictEqual(dom.comments[4].text, 'Sizes S to XXL');
  const owner = extractDom.pickOwnerUsername({ headerOwner: dom.headerOwner, payloadOwner: '', captionAuthor: dom.captionAuthor });
  assert.strictEqual(owner, 'sample_down_shop');
});

ok('dom: fixture A dedupe on repeated rows', () => {
  const { doc } = buildFixtureA();
  const snap = withDoc(doc, () => extractDom.harvestPostDomInPage());
  const cs = extractDom.rowsToComments(snap.rows.concat(snap.rows), POST_URL_A, 50);
  assert.strictEqual(cs.length, 5);
});

// ---------- 夹具 B：没有 <header>、作者只出现在文案行（且无任何内嵌 JSON） ----------
ok('dom: fixture B caption-author fallback when no header', () => {
  const box = scrollableBox([
    commentLi('north_coats', 'Winter coats are here #winter', '2024-11-10T09:00:00.000Z', '2d'),
    commentLi('buyer_anna', 'How much is it?', '2024-11-10T10:00:00.000Z', '2d'),
    commentLi('maple_mike', 'Do you ship to Canada?', '2024-11-10T11:00:00.000Z', '1d'),
  ]);
  const article = el('article');
  article.append(el('div'), box);
  const main = el('main');
  main.append(article);
  const doc = makeDoc([navWithProfile('collector_small'), main], 'North Coats on Instagram');
  const snap = withDoc(doc, () => extractDom.harvestPostDomInPage());
  assert.deepStrictEqual(snap.headerUsernames, []);
  const dom = extractDom.analyzeSnapshot(snap, 'https://www.instagram.com/p/FIXTUREDOM2/', 50);
  assert.strictEqual(dom.headerOwner, '');
  assert.strictEqual(dom.captionAuthor, 'north_coats');
  assert.strictEqual(dom.captionText, 'Winter coats are here #winter');
  assert.strictEqual(dom.comments.length, 3);
  const owner = extractDom.pickOwnerUsername({ headerOwner: dom.headerOwner, payloadOwner: '', captionAuthor: dom.captionAuthor });
  assert.strictEqual(owner, 'north_coats');
});

// ---------- 上限：60 行夹具按 cap=50 截断 ----------
ok('dom: cap stops at 50 of 60 rows', () => {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const u = 'user_' + String(i).padStart(2, '0');
    rows.push(commentLi(u, 'Question number ' + i + ' about price?', '2024-11-11T13:00:00.000Z', '3h'));
  }
  const header = el('header');
  header.append(el('a', { href: '/bulk_shop/' }, 'bulk_shop'));
  const rightCol = el('div');
  rightCol.append(header, scrollableBox(rows));
  const article = el('article');
  article.append(el('div'), rightCol);
  const main = el('main');
  main.append(article);
  const doc = makeDoc([navWithProfile(null), main], 'Bulk Shop on Instagram');
  const snap = withDoc(doc, () => extractDom.harvestPostDomInPage());
  assert.strictEqual(snap.rows.length, 60);
  const dom = extractDom.analyzeSnapshot(snap, 'https://www.instagram.com/p/FIXTUREDOM3/', 50);
  assert.strictEqual(dom.comments.length, 50);
  assert.strictEqual(dom.comments[0].ownerUsername, 'user_00');
  assert.strictEqual(dom.comments[49].ownerUsername, 'user_49');
});

// ---------- 空页面：什么都没有 -> 全 0 且触发调试证据条件 ----------
ok('dom: empty page gives zeros and debug trigger', () => {
  const doc = makeDoc([navWithProfile('collector_small')], 'Instagram');
  const snap = withDoc(doc, () => extractDom.harvestPostDomInPage());
  assert.deepStrictEqual(snap.rows, []);
  assert.deepStrictEqual(snap.headerUsernames, []);
  assert.strictEqual(snap.counts.commentRowCandidates, 0);
  assert.strictEqual(snap.hasCommentsContainer, false);
  const dom = extractDom.analyzeSnapshot(snap, 'https://www.instagram.com/p/EMPTY/', 50);
  assert.strictEqual(dom.comments.length, 0);
  assert.strictEqual(extractDom.needsPostDebug({ ownerUsername: '' }, []), true);
  assert.strictEqual(extractDom.needsPostDebug({ ownerUsername: 'someone' }, []), false);
  assert.strictEqual(extractDom.needsPostDebug({ ownerUsername: '' }, [extract.normalizeComment({ text: 'hi', ownerUsername: 'a' })]), false);
});

// ---------- 导航用户名（独立函数） ----------
ok('dom: navProfileUsernameInPage finds nav profile, else null', () => {
  const { doc } = buildFixtureA();
  assert.strictEqual(withDoc(doc, () => extractDom.navProfileUsernameInPage()), 'collector_small');
  const bare = makeDoc([navWithProfile(null)], 'Instagram');
  assert.strictEqual(withDoc(bare, () => extractDom.navProfileUsernameInPage()), null);
});

// ---------- 滚动函数：滚的是 harvest 标记的那个容器 ----------
ok('dom: scrollCommentsInPage scrolls the marked container', () => {
  const { doc, box } = buildFixtureA();
  const r = withDoc(doc, () => {
    extractDom.harvestPostDomInPage();
    const first = extractDom.scrollCommentsInPage();
    const second = extractDom.scrollCommentsInPage();
    return { first, second };
  });
  assert.strictEqual(r.first.found, true);
  assert.strictEqual(r.first.scrolled, true);
  assert.strictEqual(box.scrollTop, 2400);
  assert.strictEqual(r.second.scrolled, false); // 已经到底，不再动
});

// ---------- 合并：DOM 主来源 + JSON 次来源去重 ----------
ok('dom: mergeComments dedupe, order and cap', () => {
  const mk = (u, t) => extract.normalizeComment({ ownerUsername: u, text: t, postUrl: 'https://www.instagram.com/p/X/' });
  const merged = extractDom.mergeComments([mk('a', 'x'), mk('b', 'y')], [mk('b', 'y'), mk('c', 'z')], 50);
  assert.deepStrictEqual(merged.map((c) => c.ownerUsername), ['a', 'b', 'c']);
  assert.strictEqual(extractDom.mergeComments([mk('a', 'x'), mk('b', 'y'), mk('c', 'z')], [], 2).length, 2);
});

console.log('DOM 提取单测全部通过：' + passed + ' 项');
