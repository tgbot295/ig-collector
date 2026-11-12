'use strict';
// 两列客户名单（src/leadsOut.js）的纯函数单测：只出 用户链接 + 评论内容。
// 覆盖：意向限定、商家自评剔除、跨帖去重、空字段跳过、CSV 的 BOM/表头/转义。
const assert = require('assert');
const leadsOut = require('../src/leadsOut');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

// 夹具：2 个帖子条目（带 latestComments）+ 1 个独立评论条目（无 latestComments，
// 应被自然忽略）+ 1 个空条目。全部虚构。
const ITEMS = [
  {
    ownerUsername: 'shop_a',
    latestComments: [
      { ownerUsername: 'buyer_anna', text: 'How much? How to buy?', intentTypes: ['问价格', '问购买'] },
      // 商家自评：有意向类型也要剔除
      { ownerUsername: 'shop_a', text: 'DM us to order', intentTypes: ['问购买'] },
      // 讨厌的文本：逗号 + 双引号 + 换行都有
      { ownerUsername: 'buyer_ben', text: 'He said "nice", and left\na second line — how much?', intentTypes: ['问价格'] },
      // --keep-all 风格的无意向评论：名单里不能出现
      { ownerUsername: 'casual_cat', text: 'Nice!', intentTypes: [] },
      // 同帖内重复（同人同句）
      { ownerUsername: 'buyer_anna', text: 'How much? How to buy?', intentTypes: ['问价格', '问购买'] },
      // 空用户名 / 空文本
      { ownerUsername: '', text: 'how much', intentTypes: ['问价格'] },
      { ownerUsername: 'buyer_eve', text: '   ', intentTypes: ['问价格'] },
      { ownerUsername: 'buyer_eve', text: '', intentTypes: ['问价格'] },
    ],
  },
  { ownerUsername: 'someone_else', text: 'how much is this?', intentTypes: ['问价格'] }, // 独立评论条目，无 latestComments
  {
    ownerUsername: 'shop_b',
    latestComments: [
      // 跨帖重复（同人同句，另一家帖下）→ 去重
      { ownerUsername: 'buyer_anna', text: 'How much? How to buy?', intentTypes: ['问价格', '问购买'] },
      { ownerUsername: 'buyer_dan', text: '请问多少钱，怎么购买', intentTypes: ['问价格', '问购买'] },
    ],
  },
  null,
  { ownerUsername: 'shop_c' }, // 没有 latestComments 的帖子条目
];

ok('rows: 只出意向评论，剔除商家自评/无意向/空字段，跨帖去重保序', () => {
  const rows = leadsOut.buildLeadsRows(ITEMS);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0], {
    profileUrl: 'https://www.instagram.com/buyer_anna/',
    comment: 'How much? How to buy?',
  });
  assert.strictEqual(rows[1].profileUrl, 'https://www.instagram.com/buyer_ben/');
  assert.deepStrictEqual(rows[2], {
    profileUrl: 'https://www.instagram.com/buyer_dan/',
    comment: '请问多少钱，怎么购买',
  });
});

ok('rows: 空输入/非数组不炸，出空名单', () => {
  assert.deepStrictEqual(leadsOut.buildLeadsRows([]), []);
  assert.deepStrictEqual(leadsOut.buildLeadsRows(null), []);
  assert.deepStrictEqual(leadsOut.buildLeadsRows(undefined), []);
});

ok('rows: intentTypes 缺失（老格式评论）不算意向，不出名单', () => {
  const rows = leadsOut.buildLeadsRows([
    { ownerUsername: 'shop_x', latestComments: [{ ownerUsername: 'buyer_zed', text: 'how much' }] },
  ]);
  assert.deepStrictEqual(rows, []);
});

ok('csv: BOM 开头 + 表头一字不差 + CRLF', () => {
  const csv = leadsOut.toCsv(leadsOut.buildLeadsRows(ITEMS));
  const buf = Buffer.from(csv, 'utf8');
  assert.deepStrictEqual([buf[0], buf[1], buf[2]], [0xef, 0xbb, 0xbf]); // UTF-8 BOM
  const body = csv.slice(1); // 去 BOM
  assert.ok(body.startsWith('用户链接,评论内容\r\n'));
  assert.ok(body.endsWith('\r\n'));
});

ok('csv: 含逗号/引号/换行的评论按标准加引号、引号翻倍', () => {
  const csv = leadsOut.toCsv(leadsOut.buildLeadsRows(ITEMS));
  const expectedBen = 'https://www.instagram.com/buyer_ben/,"He said ""nice"", and left\na second line — how much?"';
  assert.ok(csv.includes(expectedBen), 'buyer_ben 行转义不对：\n' + csv);
  // 普通评论不加引号
  assert.ok(csv.includes('https://www.instagram.com/buyer_anna/,How much? How to buy?'));
  // 中文评论含中文逗号不是 ASCII 逗号……它含「，」不需转义；但含 ASCII 标点时也应原样
  assert.ok(csv.includes('https://www.instagram.com/buyer_dan/,请问多少钱，怎么购买'));
});

ok('csv: 0 条时只有表头（名单为空也要有文件）', () => {
  const csv = leadsOut.toCsv([]);
  assert.strictEqual(csv, '﻿用户链接,评论内容\r\n');
});

console.log('leads-out tests: ' + passed + ' passed');
