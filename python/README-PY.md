# IG 采集引擎 · Python 核心版

JS 版（仓库根目录）的 Python 移植，逻辑逐条对齐，并带上三处实地修复
（见文末）。零依赖（除 playwright 外全是标准库），Python 3.11+。

## 怎么用

1. 安装 Python 3.11+（勾选 Add Python to PATH）。
2. 把卖家给的 cookie 文件放进 **`python/cookies/`** 文件夹（文件名随便，
   可放多个，按文件名顺序逐个试）。cookie 文件 = 账号钥匙，只放本地。
3. Windows 双击 `Start-Windows.bat`，或手动：

   ```powershell
   py -m pip install -r requirements.txt
   py collector.py --keyword downjacket
   ```

   **不要**跑 `playwright install chromium`：浏览器默认用本机现成的
   Google Chrome（其次 Edge，最后才自带 Chromium）。自带内核的下载源
   在部分地区被墙（403），所以启动器里没有这一步。
4. 结果在 `python/out/`：
   - `leads-<关键词>-<时间>.csv`：**最终名单**，只有两列（用户链接、
     评论内容），Excel 双击可开。
   - `collect-<关键词>-<时间>.json`：本轮完整记录。
   - `debug-post-<帖子>.png/.json`：评论读取异常时自动存的现场证据。

常用参数：`--keyword` 可重复/逗号分隔（最多 10 个词，一轮跑完）；
`--min-followers 10000`、`--bloggers 5`、`--posts-per-blogger 10`；
`--no-blogger-mode` 回到话题帖直采（配 `--posts 50`）；
`--max-age-days 365` 只采近期帖；`--check-cookies` 只体检 cookie
文件不登录；`--import-cookies <文件>` 指定单个会话文件。

## 工作方式（每个关键词）

博主模式（默认）：① 话题页收集帖子链接，快速打开认发帖人（候选
≤30 人）→ ② 逐个看候选人主页筛商家 + 粉丝数（粉丝读不到不入选），
打印候选表，选粉丝最多的前 N 个 → ③ 只采选中博主帖子下的评论。
一个合格博主都没有时自动回退话题帖直采。

逐帖筛选：发布时间超过 `--max-age-days` 的跳过；评论只保留带购买
意向的（问购买/问价格/问运费/问尺码，中英双语）；帖主自评、重复
评论不进名单。遇到验证/限流页立即停并保存已采数据。

主号黑名单写死：nataliem.jordan / mm8989221 / lvlong2026 —— 候选
文件附带账号名命中（卖家整行预检）或实际登录账号命中，立即中止。

## 文件结构

| 文件 | 作用 |
|---|---|
| `collector.py` | CLI + 流水线（登录核验逐候选试、博主三步、逐帖处理、收尾保存） |
| `cookies_parse.py` | 纯函数：cookie 文件全格式解析（JSON/Base64 包装/卖家整行/Netscape/Cookie 头/UTF-16 编码层）+ 体检 |
| `login_guard.py` | 纯函数：黑名单、停止页检测、两轮登录核验分类器 |
| `intent.py` | 纯函数：评论意向四分类 |
| `filters.py` | 纯函数：商家售卖信号表、帖子新鲜度判定 |
| `bloggers.py` | 纯函数：粉丝数解析（含 meta description）、候选评估、选博主规则 |
| `extract.py` | 页面内 JS 片段 + 收割包装：帖子/评论 DOM 收割、资料页收割 |
| `browser_bits.py` | 浏览器启动回退、上下文注 cookie、关插屏、登录信号采集与核验 |
| `leads_out.py` | 纯函数：两列名单 CSV（BOM + CRLF） |
| `tests/run_tests.py` | 纯模块测试（不需要 playwright）：`py tests/run_tests.py` |

## 还没包含的（后续阶段）

JS 版的图形控制台（GUI）、跨运行累积存储（data/store.json）、
Excel 导出、accounts.txt 密码+TOTP 自动登录、会话导出——本核心版
都还没有。先把“cookie 登录 → 找博主 → 采意向评论 → 出名单”这条
主链在真实机器上跑通，再往上加。

## 带上的三处实地修复（JS 版的病，Python 版不继承）

1. **文案冒充评论（FIX A）**：JS 版实地跑出每条帖子恒“评论共 1 条、
   意向 0 条”——那条是帖子文案行被当成了评论。Python 版在
   `extract.filter_comment_rows` 里把“帖主本人 + 正文与文案一致”
   的行明确剔除。
2. **评论展开与定向滚动（FIX B）**：打开帖子先点“查看全部评论 /
   Load more comments”等展开控件（最多 3 次，滚动间补点）；滚动
   目标是文案行的可滚动祖先（评论列），不再盲滚整页。
3. **低产量自检 + 粉丝 meta 解析（FIX C）**：页面自报评论数 ≥5 而
   实际读到不足三成时，自动存 `out/debug-post-<code>.png/.json`
   证据并在日志里明说“页面显示约 N 条，只读到 M 条”；博主粉丝数
   第一优先读资料页 meta description 里的 “X Followers”（JS 版没
   读它，实地跑出过“粉丝 未知”）。

## 安全红线

- cookie/会话文件等于账号钥匙：只放本地，不要上传、不要分享、
  不要发到任何聊天里；任何日志、报错、体检输出都只有 cookie
  名字，绝不出现值，卖家整行的密码/邮箱也从不出现在任何输出里。
- 动作间隔随机 3–6 秒；单轮帖子/评论都有硬上限；遇到验证、检查点、
  限流立即停，不硬闯、不绕验证码。
