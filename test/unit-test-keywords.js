'use strict';
// 多关键词参数单测：纯本地。覆盖 --keyword 重复写、逗号分隔、--keywords
// 别名、去重、上限 10 个，以及程序化入口 argsFromOptions 的同口径拼装。
const assert = require('assert');
const { parseArgs, normalizeKeywords, argsFromOptions } = require('../collector');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

ok('single keyword (back-compat: keyword field = first)', () => {
  const a = parseArgs(['--keyword', 'down jacket']);
  assert.deepStrictEqual(a.keywords, ['downjacket']);
  assert.strictEqual(a.keyword, 'downjacket');
});

ok('repeated --keyword flags accumulate in order', () => {
  const a = parseArgs(['--keyword', 'a', '--keyword', 'b']);
  assert.deepStrictEqual(a.keywords, ['a', 'b']);
  assert.strictEqual(a.keyword, 'a');
});

ok('comma-separated values split and cleaned', () => {
  const a = parseArgs(['--keyword', 'a,b, c ,#d e']);
  assert.deepStrictEqual(a.keywords, ['a', 'b', 'c', 'de']);
});

ok('--keywords alias (space and = forms)', () => {
  assert.deepStrictEqual(parseArgs(['--keywords', 'x,y']).keywords, ['x', 'y']);
  assert.deepStrictEqual(parseArgs(['--keywords=z']).keywords, ['z']);
  assert.deepStrictEqual(parseArgs(['--keyword', 'a', '--keywords', 'b']).keywords, ['a', 'b']);
});

ok('dedupe across flags and commas', () => {
  const a = parseArgs(['--keyword', 'a', '--keyword', 'a', '--keywords', 'a,b']);
  assert.deepStrictEqual(a.keywords, ['a', 'b']);
});

ok('hard cap of 10 keywords per run', () => {
  const many = [];
  for (let i = 1; i <= 12; i++) many.push('--keyword', 'k' + i);
  const a = parseArgs(many);
  assert.strictEqual(a.keywords.length, 10);
  assert.strictEqual(a.keywords[9], 'k10');
});

ok('no keyword → keywords empty, keyword empty (usage path intact)', () => {
  const a = parseArgs(['--posts', '5']);
  assert.deepStrictEqual(a.keywords, []);
  assert.strictEqual(a.keyword, '');
});

ok('new flags default off: rescan / gui / exportXlsx', () => {
  const a = parseArgs(['--keyword', 'a']);
  assert.strictEqual(a.rescan, false);
  assert.strictEqual(a.gui, false);
  assert.strictEqual(a.exportXlsx, null);
  assert.strictEqual(parseArgs(['--keyword', 'a', '--rescan']).rescan, true);
  assert.strictEqual(parseArgs(['--gui']).gui, true);
  assert.strictEqual(parseArgs(['--export-xlsx']).exportXlsx, '');
  assert.strictEqual(parseArgs(['--export-xlsx', '/tmp/x.xlsx']).exportXlsx, '/tmp/x.xlsx');
  assert.strictEqual(parseArgs(['--export-xlsx=/tmp/y.xlsx']).exportXlsx, '/tmp/y.xlsx');
  // --export-xlsx 后面跟另一个参数时不许把参数吞成路径
  assert.strictEqual(parseArgs(['--export-xlsx', '--keyword', 'a']).exportXlsx, '');
});

ok('normalizeKeywords direct: commas, #, spaces, case preserved', () => {
  assert.deepStrictEqual(normalizeKeywords(['a,b', '#Hash Tag', '  ', null]), ['a', 'b', 'HashTag']);
  assert.deepStrictEqual(normalizeKeywords([]), []);
  assert.deepStrictEqual(normalizeKeywords(null), []);
});

ok('argsFromOptions: GUI-shaped opts → same args shape, posts clamped', () => {
  const a = argsFromOptions({ keywords: ['x', 'y'], posts: 999 });
  assert.deepStrictEqual(a.keywords, ['x', 'y']);
  assert.strictEqual(a.keyword, 'x');
  assert.strictEqual(a.posts, 50); // 硬上限
  const b = argsFromOptions({ keyword: 'solo' });
  assert.deepStrictEqual(b.keywords, ['solo']);
  const c = argsFromOptions({});
  assert.deepStrictEqual(c.keywords, []);
});

console.log('多关键词单测全部通过：' + passed + ' 项');
