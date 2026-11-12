'use strict';
// 采集筛选的纯判定函数（可单测）：帖子新鲜度 + 商家帖文案信号。
//
// 商家信号与本地版工具 app/src/intentLeads.js 的 SELLING_SIGNALS 对齐
// （同样的 key/label/判定口径，保证两个工具认定的“商家帖”一致），
// 在此基础上按用户明确要求补了：私信、商店、店铺、store、订购、批发、
// wholesale、出售、wa.me。
// 注意：不用单个“店”字作信号——“咖啡店/书店”这类生活词会误伤路人帖；
// 用“商店/店铺”两个完整词，既能命中卖家文案，又避开“在这家咖啡店”。

const SELLING_SIGNALS = [
  // —— 与 app/src/intentLeads.js 的 SELLING_SIGNALS 逐条对齐 ——
  { key: 'price-word', label: '文案含 price', re: /price/i },
  { key: 'usd', label: '文案含 $', re: /\$/ },
  { key: 'cny', label: '文案含 ¥', re: /¥/ },
  { key: 'dm-to-buy', label: '文案含 DM to buy/order', re: /\bdm\b[^.,;]{0,24}(buy|order)/i },
  { key: 'shop', label: '文案含 shop', re: /\bshop\b/i },
  { key: 'sale', label: '文案含 sale', re: /\bsale\b/i },
  { key: 'whatsapp', label: '文案含 WhatsApp', re: /whatsapp/i },
  { key: 'link-in-bio', label: '文案含 link in bio', re: /link in bio/i },
  { key: 'order', label: '文案含 order', re: /\border\b/i },
  { key: 'goumai', label: '文案含 购买', re: /购买/ },
  { key: 'jiage', label: '文案含 价格', re: /价格/ },
  { key: 'xiadan', label: '文案含 下单', re: /下单/ },
  // —— 用户点名要的补充信号（卖家文案常见词） ——
  { key: 'sixin', label: '文案含 私信', re: /私信/ },
  { key: 'store', label: '文案含 store', re: /\bstore\b/i },
  { key: 'shangdian', label: '文案含 商店', re: /商店/ },
  { key: 'dianpu', label: '文案含 店铺', re: /店铺/ },
  { key: 'dinggou', label: '文案含 订购', re: /订购/ },
  { key: 'pifa', label: '文案含 批发', re: /批发/ },
  { key: 'wholesale', label: '文案含 wholesale', re: /wholesale/i },
  { key: 'chushou', label: '文案含 出售', re: /出售/ },
  { key: 'wame', label: '文案含 wa.me', re: /wa\.me/i },
];

// 文案命中的售卖信号 label 列表（按信号表顺序）；空数组 = 非商家帖。
function merchantSignalsOf(caption) {
  const t = String(caption || '');
  return SELLING_SIGNALS.filter((s) => s.re.test(t)).map((s) => s.label);
}

function isMerchantCaption(caption) {
  return merchantSignalsOf(caption).length > 0;
}

// 帖子新鲜度判定（纯函数）：
// - maxAgeDays <= 0 或非法 → 不限，恒 keep；
// - timestamp 缺失/认不出 → keep（ageDays 给 null，照常采集，调用方标 unknown）；
// - ageDays = (now - 发布时间) / 天；严格大于上限才 skip（正好等于上限保留）；
//   未来的时间（时钟偏差）ageDays 为负，keep。
function decidePostAge(opts) {
  const o = opts || {};
  const limit = Number(o.maxAgeDays);
  if (!Number.isFinite(limit) || limit <= 0) return { action: 'keep', ageDays: null };
  const ts = o.timestamp ? new Date(o.timestamp).getTime() : NaN;
  if (!Number.isFinite(ts)) return { action: 'keep', ageDays: null };
  const ref = o.now !== undefined && o.now !== null ? new Date(o.now).getTime() : Date.now();
  if (!Number.isFinite(ref)) return { action: 'keep', ageDays: null };
  const ageDays = (ref - ts) / 86400000;
  return ageDays > limit
    ? { action: 'skip', ageDays: ageDays }
    : { action: 'keep', ageDays: ageDays };
}

module.exports = { SELLING_SIGNALS, merchantSignalsOf, isMerchantCaption, decidePostAge };
