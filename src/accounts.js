'use strict';
// accounts.txt 解析（纯本地）：一行一个账号，格式
//   username----password----email----totpSecret
// email、totpSecret 可省略。# 开头为注释行，空行跳过。
//
// 安全红线：
// - 本模块的任何输出（列表、警告、公开视图）只允许出现用户名和行号，
//   绝不包含密码 / TOTP 密钥 / 邮箱原文。
// - 黑名单主号在选择阶段就被拒绝（selectAccount 返回 blocked）。
const fs = require('fs');
const guard = require('./guard');

const SEPARATOR = '----';

function parseAccountsText(text) {
  const accounts = [];
  const warnings = [];
  const seen = new Set();
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split(SEPARATOR).map((p) => p.trim());
    const username = parts[0] || '';
    const password = parts[1] || '';
    if (!username || !password) {
      // 警告只带行号，绝不回显行内容（里面可能有密码）
      warnings.push({ line: lineNo, message: '格式不完整（缺用户名或密码），已跳过' });
      return;
    }
    const key = guard.normalizeUsername(username);
    if (seen.has(key)) {
      warnings.push({ line: lineNo, message: '用户名重复，已跳过' });
      return;
    }
    seen.add(key);
    accounts.push({
      username: username,
      password: password,
      email: parts[2] || '',
      totpSecret: (parts[3] || '').replace(/\s+/g, ''),
      blocked: guard.isBlockedUsername(username),
      line: lineNo,
    });
  });
  return { accounts: accounts, warnings: warnings };
}

function loadAccounts(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return parseAccountsText(text);
}

// 公开视图：只能拿去打印/记日志——只有用户名和有无标记，没有任何秘密
function publicView(account) {
  if (!account) return null;
  return {
    username: account.username,
    hasPassword: !!account.password,
    hasEmail: !!account.email,
    hasTotp: !!account.totpSecret,
    blocked: !!account.blocked,
  };
}

function listUsernames(accounts) {
  return (accounts || []).map((a) => a.username);
}

// 按用户名选账号（大小写不敏感）。返回 {account} 或 {error, ...}
function selectAccount(accounts, wanted) {
  const target = guard.normalizeUsername(wanted);
  const found = (accounts || []).find((a) => guard.normalizeUsername(a.username) === target);
  if (!found) return { error: 'not_found' };
  if (found.blocked || guard.isBlockedUsername(found.username)) return { error: 'blocked', account: found };
  return { account: found };
}

module.exports = {
  SEPARATOR,
  parseAccountsText,
  loadAccounts,
  publicView,
  listUsernames,
  selectAccount,
};
