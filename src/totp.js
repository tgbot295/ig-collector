'use strict';
// RFC 6238 TOTP 生成（只用 Node 内置 crypto，无第三方依赖）。
// 输入是 base32 编码的密钥（验证器 App 备份密钥常见形式），输出 6 位动态码。
const crypto = require('crypto');

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const s = String(input || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('TOTP 密钥不是有效的 base32 编码');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// options: timestampMs（默认现在）、digits（默认 6）、period 秒（默认 30）、algorithm（默认 sha1）
function generateTotp(secretBase32, options) {
  const opts = options || {};
  const digits = opts.digits || 6;
  const period = opts.period || 30;
  const algorithm = opts.algorithm || 'sha1';
  const timestampMs = opts.timestampMs !== undefined ? opts.timestampMs : Date.now();

  const key = base32Decode(secretBase32);
  const counter = Math.floor(timestampMs / 1000 / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter), 0);
  const digest = crypto.createHmac(algorithm, key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const code = binary % Math.pow(10, digits);
  return String(code).padStart(digits, '0');
}

module.exports = { base32Decode, generateTotp };
