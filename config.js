'use strict';
// 本地采集引擎配置：限速、限量、黑名单全部写死在这里，不提供关掉的开关。
const path = require('path');
const { DEFAULT_BLOCKLIST } = require('./src/guard');

module.exports = {
  baseUrl: 'https://www.instagram.com',
  // 关键词话题页（关键词会自动去掉 # 和空格，如 "down jacket" -> #downjacket）
  tagsUrl: (keyword) =>
    'https://www.instagram.com/explore/tags/' + encodeURIComponent(keyword) + '/',

  // 持久登录态目录：只存在本机，含登录会话，绝不能分享/上传（见 README）
  // 手动模式用 browser-profile/ 本身；账号模式用 browser-profile/<用户名>/ 各自独立
  profileDir: path.join(__dirname, 'browser-profile'),
  profileDirFor: (username) =>
    path.join(__dirname, 'browser-profile',
      String(username || '').trim().replace(/^@+/, '').toLowerCase()),
  outDir: path.join(__dirname, 'out'),

  // 累积存储：历次运行采过的帖子 + 意向客户名单都攒在 data/store.json，
  // 跨运行去重（采过的帖子默认跳过、名单只增不重）。纯本地数据，
  // 已被 .gitignore 排除（data/ 整夹不进仓库）。
  dataDir: path.join(__dirname, 'data'),
  storeFile: path.join(__dirname, 'data', 'store.json'),

  // 图形控制台（--gui）监听端口：只绑 127.0.0.1，不对外。
  guiPort: 3212,

  // 会话文件目录：登录成功导出的 <用户名>.storage.json 存这里（等同 TG 的 .session，
  // 是账号钥匙，只放本机，绝不能分享/上传/发聊天，见 sessions/README-警告.md）
  sessionsDir: path.join(__dirname, 'sessions'),

  // 自动模式默认扫描的 cookie 文件夹：卖家给的 cookie 文件丢进来即可，
  // 文件名任意（可无扩展名），脚本自动读取。里面的文件 = 账号钥匙，
  // 只放本机，已被 .gitignore 整夹排除（只保留说明文件）。
  cookiesDir: path.join(__dirname, 'cookies'),

  // 账号文件（只放本机，含密码，绝不能分享/上传/发聊天）
  accountsFile: path.join(__dirname, 'accounts.txt'),

  // 主号黑名单：登录账号命中立即中止（写死）
  blocklist: DEFAULT_BLOCKLIST,

  limits: {
    postsDefault: 50,
    postsMax: 50,        // 单次帖子硬上限
    commentsDefault: 50, // 每帖评论默认上限
    commentsMax: 200,
    scrollRoundsMax: 15, // 话题页最多滚动轮数
  },

  // 博主模式（默认开）：先按关键词找卖货博主（商家 + 粉丝够多），再采
  // 他们帖子下面的意向评论。--no-blogger-mode 回到话题帖直采。
  blogger: {
    minFollowersDefault: 10000, // 入选博主的最低粉丝数（--min-followers）
    minFollowersMax: 100000000,
    bloggersDefault: 5,         // 每个关键词最多选几个博主（--bloggers）
    bloggersMax: 20,
    postsPerBloggerDefault: 10, // 每个博主最多采几条帖子（--posts-per-blogger）
    postsPerBloggerMax: 50,
    candidatePosts: 60,         // 找候选时话题页最多收集多少条帖子链接
    fastPassPosts: 30,          // 找候选时最多快速打开多少条帖子认发帖人
    ownersMax: 20,              // 候选博主名单上限
    gridScrollRounds: 6,        // 博主主页网格最多滚动轮数
  },

  // 人类节奏：主要动作之间随机停 3–6 秒（写死）
  delays: { minMs: 3000, maxMs: 6000 },

  navTimeoutMs: 45000,
  actionTimeoutMs: 30000,
};
