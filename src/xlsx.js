'use strict';
// 一键导出 Excel：只用 Node 标准库手写一个最小可用的 .xlsx。
// xlsx 本质是个 ZIP 包，里面放几份固定 XML；这里自己算 CRC32、自己拼
// ZIP 本地头/中央目录（zlib 做 deflate 压缩），不引入任何第三方依赖。
// 工作表用 inlineStr 内联字符串单元格：所有值都按纯文本写，评论里以
// "=" 开头的内容也只是字符串，不会被 Excel 当公式执行。
// 导出内容与 CSV 完全同口径：只有两列——用户链接、评论内容。

const fs = require('fs');
const zlib = require('zlib');

// ---- CRC32（ZIP 校验用，标准多项式 0xEDB88320）----
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---- 最小 ZIP 打包：entries = [{ name, data(Buffer) }]，返回整个包的 Buffer ----
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const compressed = zlib.deflateRawSync(entry.data, { level: 6 });
    // deflate 后反而更大时改存原样（小文件常见），两种都是合法 ZIP
    const useStore = compressed.length >= entry.data.length;
    const payload = useStore ? entry.data : compressed;
    const method = useStore ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 通用标志：文件名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // 修改时间（固定 0，够用）
    local.writeUInt16LE(0x21, 12); // 修改日期（1980-01-01 的 DOS 表示）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度
    chunks.push(local, nameBuf, payload);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    cen.writeUInt16LE(20, 4); // 制作版本
    cen.writeUInt16LE(20, 6); // 解压所需版本
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(entry.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42); // 本地头偏移
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // 中央目录结束签名
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

// XML 文本转义：& < > 必转，引号在文本内容里不用转但转了也无害——这里只转
// & < > 三个（文本节点足够），外加回车以外的控制字符会被 Excel 拒收，直接剔除。
function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function colName(n) {
  let s = '';
  let m = n;
  while (m > 0) {
    const r = (m - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    m = Math.floor((m - 1) / 26);
  }
  return s;
}

function inlineCell(ref, value) {
  return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' +
    xmlEscape(value) + '</t></is></c>';
}

// rows = [{ profileUrl, comment }] → 完整 xlsx 的 Buffer（首行是表头）。
function buildLeadsXlsx(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const allRows = [['用户链接', '评论内容']];
  for (const r of list) allRows.push([r && r.profileUrl, r && r.comment]);
  const sheetRows = allRows.map((row, i) => {
    const cells = row.map((v, j) => inlineCell(colName(j + 1) + (i + 1), v)).join('');
    return '<row r="' + (i + 1) + '">' + cells + '</row>';
  }).join('');
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    sheetRows + '</sheetData></worksheet>';
  const contentTypes = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
  const rootRels = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const workbook = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="客户名单" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const workbookRels = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf8') },
  ]);
}

// 把 rows 写成 .xlsx 文件，返回写入的行数（不含表头）。
function exportLeadsXlsx(rows, filePath) {
  fs.writeFileSync(filePath, buildLeadsXlsx(rows));
  return Array.isArray(rows) ? rows.length : 0;
}

module.exports = { buildLeadsXlsx, exportLeadsXlsx, crc32, buildZip, xmlEscape };
