'use strict';
// Excel 导出单测：纯本地。用 buildLeadsXlsx 造一个 2 行的 xlsx，再用一个
// 独立的极简 ZIP 读者（只按 ZIP 规范读中央目录 + 本地头 + inflate）把
// sheet1.xml 掏出来验内容——不复用 xlsx.js 自己的任何拼包逻辑，
// 保证“写出来的包”真的能被别的读者打开。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const xlsx = require('../src/xlsx');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

// 独立读者：返回 { 条目名: Buffer }
function unzipAll(buf) {
  // 从尾部找中央目录结束记录（EOCD，签名 0x06054b50）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.notStrictEqual(eocd, -1, '找不到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    assert.strictEqual(buf.readUInt32LE(off), 0x02014b50, '中央目录签名不对');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const rawSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    // 跳到本地头取数据
    assert.strictEqual(buf.readUInt32LE(localOff), 0x04034b50, '本地头签名不对');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(dataStart, dataStart + compSize);
    const data = method === 8 ? zlib.inflateRawSync(comp) : comp;
    assert.strictEqual(data.length, rawSize, name + ' 解压后长度对不上');
    out[name] = data;
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

ok('crc32 known vector', () => {
  assert.strictEqual(xlsx.crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926);
});

const ROWS = [
  { profileUrl: 'https://www.instagram.com/alice/', comment: 'how much? A & B <test> "ok"' },
  { profileUrl: 'https://www.instagram.com/bob/', comment: '=SUM(A1:A2) ship to Canada?' },
];
let files = null;
ok('build 2-row xlsx and unzip with independent reader', () => {
  files = unzipAll(xlsx.buildLeadsXlsx(ROWS));
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']) {
    assert.ok(files[name], '缺条目 ' + name);
  }
  assert.ok(files['xl/workbook.xml'].toString('utf8').includes('客户名单'));
});

ok('sheet has exact header + both data rows', () => {
  const sheet = files['xl/worksheets/sheet1.xml'].toString('utf8');
  assert.ok(sheet.includes('用户链接'), '缺表头 用户链接');
  assert.ok(sheet.includes('评论内容'), '缺表头 评论内容');
  assert.ok(sheet.includes('https://www.instagram.com/alice/'));
  assert.ok(sheet.includes('https://www.instagram.com/bob/'));
  assert.ok(sheet.includes('ship to Canada?'));
});

ok('sheet escapes & < > in cell text', () => {
  const sheet = files['xl/worksheets/sheet1.xml'].toString('utf8');
  assert.ok(sheet.includes('A &amp; B &lt;test&gt;'), '特殊字符没有按 XML 转义');
  assert.ok(!sheet.includes('A & B <test>'), '原始未转义文本不该出现');
});

ok('formula-like leading "=" stays a plain inline string, not a formula', () => {
  const sheet = files['xl/worksheets/sheet1.xml'].toString('utf8');
  assert.ok(sheet.includes('=SUM(A1:A2)'), '等号开头的评论原文要保留');
  assert.ok(!sheet.includes('<f>'), '不该出现公式元素 <f>');
  // 它所在的单元格必须是 inlineStr 文本单元格
  const idx = sheet.indexOf('=SUM(A1:A2)');
  const cellStart = sheet.lastIndexOf('<c ', idx);
  assert.ok(sheet.slice(cellStart, idx).includes('t="inlineStr"'), '等号评论应写在 inlineStr 单元格里');
});

ok('exportLeadsXlsx writes a file and returns row count', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ig-xlsx-test-')), 'leads.xlsx');
  const n = xlsx.exportLeadsXlsx(ROWS, tmp);
  assert.strictEqual(n, 2);
  const buf = fs.readFileSync(tmp);
  assert.strictEqual(buf.toString('ascii', 0, 2), 'PK');
  const again = unzipAll(buf);
  assert.ok(again['xl/worksheets/sheet1.xml'].toString('utf8').includes('用户链接'));
});

console.log('Excel 导出单测全部通过：' + passed + ' 项');
