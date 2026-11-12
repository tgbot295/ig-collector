# 本地 IG 采集引擎（原型）

在自己电脑上运行的 Instagram 采集脚本：它打开一个自带的浏览器窗口，用一个
**专用小号**登录（两种方式见下），之后按关键词（话题）搜帖子、逐条打开、
读取公开评论，最后把结果写成本地 JSON 文件，可以直接导入 `../app/` 那个
本地版 IG 工具继续筛选意向客户、出表。

- 不用 Apify，不经过任何第三方平台，数据只留在本机。
- 每次运行**只用一个账号**，不轮换、不多号并行；遇到验证/限流就停，不会
  换号硬闯。

## 登录方式

什么都不指定时是**自动模式**：优先自动读 `cookies/` 文件夹里的卖家
cookie 文件（文件名随便），细则见文末「自动模式」一节。下面两种是显式
指定的方式，给了参数就优先于自动模式。

### A) accounts.txt 账号文件自动登录（推荐日常用）

在 collector 文件夹里建一个 `accounts.txt`（可参考 `accounts.txt.example`
模板），一行一个账号，用 `----` 分隔：

```
用户名----密码----邮箱----TOTP密钥
```

- 邮箱、TOTP 密钥两列可以省略，只写 `用户名----密码` 也能用；
- TOTP 密钥就是验证器 App 绑定时那串 base32 备份密钥（不是 6 位动态码本身）；
- 运行时指定用哪个账号：

```bash
node collector.js --keyword downjacket --account 你的小号用户名
```

- 脚本会自动打开登录页填用户名和密码；跳出双重验证时：
  - 填了 TOTP 密钥的，脚本在本地按 RFC 6238 自己算出当前 6 位动态码填入
    （不需要你打开验证器 App）；
  - 没填 TOTP 密钥、或者 IG 发的是短信/邮件验证码的，脚本会停下来让你在
    终端里手动输入收到的码（工具读不到你的短信和邮箱，输入的码不保存）；
- 每个账号的登录态单独存在 `browser-profile/<用户名>/`，之后再跑同一个
  账号会直接复用登录态，不用再输密码；登录态过期了才会重新走自动登录；
- 如果 `accounts.txt` 里有多个账号又没加 `--account`，脚本只会列出用户名
  （不显示任何密码）让你指定，不会自己挑。

### ⚠️ accounts.txt 安全须知（重要）

- `accounts.txt` 里是明文的账号密码和 TOTP 密钥，**只放你自己的电脑本地**；
- **不要上传给任何人、不要发到聊天里、不要传网盘/GitHub**；
- 这个文件要是丢了或被人拿到，**等于账号直接丢了**（对方能直接登录，
  有 TOTP 密钥连双重验证都能过），务必像保管密码一样保管它；
- 脚本本身永远不会把密码/TOTP 密钥打印出来、写进结果文件或日志；结果目录
  `out/` 里如果发现混进的 `accounts.txt`，脚本会警告并忽略它。

### B) 手动登录（回退方式）

加 `--manual` 时走这个方式（显式指定，优先于自动模式）：脚本弹出浏览器窗口，
你在窗口里**手动登录**小号（密码只输进 IG 页面，不经过工具、不落盘），
登录好回终端按回车继续。登录态存在 `browser-profile/` 根目录。

```bash
node collector.js --keyword downjacket --manual
```

## 红线（写死在代码里，关不掉）

1. **绝不用主号采集**：选定/登录的账号如果是 `nataliem.jordan`、
   `mm8989221`、`lvlong2026` 中的任何一个——哪怕它就写在 accounts.txt 里——
   脚本会在登录前/采集前立即拒绝并中止。这三个是主号/旧号，只能用小号。
2. **限速写死**：每次最多采 50 条帖子（默认 20），每帖最多读 50 条评论
   （上限 200），每个主要动作之间随机停 3–6 秒，模拟正常人节奏。
3. **遇到拦截立即停**：出现验证/检查点页、登录墙、限流提示页时，脚本停下
   来保存已采数据并如实报告原因，不重试硬闯、不换号绕过。
4. 缺失的字段（点赞数、评论数等）一律留空（null），不会编造数字。
5. 密码、TOTP 密钥、验证码绝不出现在控制台、日志和 `out/` 结果文件里，
   控制台只显示用户名和状态。

## ⚠️ 关于 browser-profile/ 文件夹

里面是小号的**登录会话（等同于登录凭证）**，按账号分开存放。只应留在你
自己电脑上：不要发给任何人、不要上传网盘/GitHub。想彻底退出某个账号的
登录，删掉 `browser-profile/<那个用户名>/` 即可。

## 用会话文件直登（类似 TG 的 .session）

先说清：**Instagram 没有官方的会话文件格式**，不像 Telegram 有 `.session`。
但效果相同的等价物有三种，这个工具都支持：

1. **本工具导出的 `.storage.json`（最接近 TG .session 的单文件方式）**
   任何一次登录成功（accounts.txt 自动登录或手动登录）后，脚本会自动把
   当前会话导出到 `sessions/<用户名>.storage.json`（权限 0600）。
   把这一个文件拷到另一台电脑/另一个目录，运行时：

   ```bash
   node collector.js --keyword downjacket --import-session sessions/<用户名>.storage.json
   ```

   就直接是登录态，不用密码、不用 2FA。脚本会先核验登录的是哪个号，
   命中主号黑名单照样立即中止。

2. **cookie 文件（关键就一个 sessionid）**
   用浏览器 cookie 导出扩展之类拿到的 JSON 也行，裸数组或
   `{ "cookies": [...] }` 两种形状都认。另外这些卖家常见格式也都认：
   扁平字典 JSON（`{"sessionid": "...", ...}`）、整份被 Base64 包了一层
   的、卖家整行格式 用户名:密码:邮箱:标记:Base64 也可整行放入（脚本逐个
   冒号切分找 Base64 尾巴，整行里的用户名只用于开浏览器前的主号黑名单
   预检，密码/邮箱不会被打印或记录）、只有尾巴的 `PCBM:Base64...` 碎片
   也认、Netscape 格式的 cookies.txt（curl / 扩展导出的经典格式）、
   `name=value; ...` 的 Cookie 头文本。文件编码是 UTF-16（记事本另存
   的常见结果）也能读。命令是：

   ```bash
   node collector.js --keyword downjacket --import-cookies 你的cookie文件.json
   ```

   脚本只挑 instagram 域名的 cookie，登录关键是 `sessionid`（外加
   `csrftoken`、`ds_user_id`）；文件里没有 `sessionid` 会直接报错并点名
   缺它，不会硬登。

3. **`browser-profile/` 文件夹本身**
   就是前面说的登录态目录，整个文件夹拷走也能用，但它最占体积、最不
   方便，不如方式 1 的单个文件。

### ⚠️ 会话文件安全须知（和 .session 一个性质）

- **会话文件 = 账号钥匙**：谁拿到文件，谁就能直接登这个号，不需要密码
  和 2FA。只放本地，不要上传、不要分享、**不要发到聊天里**。
- 会话文件会死：账号在别处退出登录、改了密码、或者被 IG 到期作废后，
  文件就失效，脚本会报 `session_expired` 停下（不会自动改走密码登录），
  重新登录小号再导出一份新的即可。
- 导入的会话如果已经失效，脚本按 0 条结果停止并说明原因，不编造数据。
- 核验判失效现在判得很严：先关掉“保存登录信息”之类的插屏，等页面安定，
  刷新重看一次，两轮之后登录页/密码框还在才报 `session_expired`；判不
  准的只报“未能确认登录态”。而且每次核验失败都会在 `out/` 里留证据：
  `debug-<时间>.png` 是脚本当时看到的页面截图、 同名 `.json` 是当时的
  核验信号（只有 cookie 名字，没有值）。**IG 到底给脚本看了什么，看
  out/debug-*.png 这张截图**，先看图再下结论。有窗口模式下截图存完
  浏览器还会多停留约 5 秒，方便你瞥一眼真实页面。

## 安装（Windows / Mac 通用）

需要先装好 Node.js（LTS 版），并且**电脑上装有 Google Chrome（推荐）或
Microsoft Edge（Windows 自带，一般不用另装）**。脚本直接用你电脑上现成
的浏览器，不再另外下载浏览器内核。

> 为什么不下载自带内核了：Playwright 的 Chromium 内核走
> cdn.playwright.dev 下载，这个 CDN 在部分地区被墙（403 AccessDenied，
> "not available in your location"），根本装不上，所以改用本机 Chrome。

然后在本文件夹打开终端（Windows 用 PowerShell，Mac 用“终端”），运行：

```bash
npm install
```

这一条装脚本依赖（Playwright 库本身），只装这一次。

### 用哪个浏览器

启动时按顺序自动试：**本机 Google Chrome → 本机 Microsoft Edge →
Playwright 自带 Chromium**，哪个能起来用哪个，控制台会打一行
`浏览器：本机 Google Chrome` 之类的提示。三个都起不来才会停，并提示
先装 Chrome。

想强制只用某一个时：

```bash
node collector.js --keyword downjacket --browser chrome
```

`--browser` 可选 `chrome` / `msedge` / `chromium`；也可以设环境变量
`IG_COLLECTOR_BROWSER`（命令行参数优先于环境变量）。

## 日常运行

```bash
node collector.js --keyword downjacket                       # 自动模式：优先自动读 cookies/ 文件夹里的会话文件
node collector.js --keyword downjacket --account sample_small_a
node collector.js --keyword "down jacket" --posts 10 --comments 30
node collector.js --keyword downjacket --max-age-days 90     # 只采最近 90 天的帖子
node collector.js --keyword downjacket --keep-all            # 关掉意向预筛，评论全采
node collector.js --keyword downjacket --merchant-filter     # 打开商家筛选（默认关），只采文案带售卖信号的帖
node collector.js --keyword luxurybags --manual               # 强制手动登录
node collector.js --help                                      # 看用法
```

流程：确认登录（复用登录态或自动/手动登录）→ 打开话题页 → 滚动收集帖子
链接 → 逐条打开帖子 → 提取发帖人、文案、话题标签、点赞/评论数 → 过筛选
（见下）→ 展开评论区读取评论人、评论内容、时间 → 保存。

### 采集时的三道筛选（时间、意向默认开；商家默认关）

逐条打开帖子后、读评论之前，帖子要先过帖子级筛选；评论读完后还要过意向预筛：

1. **新鲜度**：只采最近发布帖子。发布时间优先取页面内嵌数据的 taken_at，
   其次取页面上帖子自己的日期，再不行用文案行的时间；都读不到就照常采
   （结果里标 `timestampSource: "unknown"`，不编造时间）。超过上限的帖子
   在读评论之前整帖跳过并计数（`stats.postsSkippedOld`），省时间。
   - `--max-age-days N`：上限天数，**默认 365**；`0` = 不限。
   - 每条保留的帖子都带 `timestamp`（ISO 时间）和 `timestampSource`
     （`"json"` / `"dom"` / `"unknown"`）。
2. **商家帖（默认关）**：默认不按商家过滤——只要帖子有评论、且评里
   有意向评论，就采集。文案有没有售卖信号只照常计算并写在帖子条目的
   `merchantSignals` 里供下游参考，不拦任何帖，
   `stats.postsSkippedNonMerchant` 恒为 0。
   - `--merchant-filter`：显式打开这道筛，打开后才只采卖家商品帖。
     判定看文案售卖信号：price、$、¥、DM to order、私信、shop / store、
     商店 / 店铺、WhatsApp / wa.me、link in bio、购买 / 下单 / 订购、
     批发 / wholesale、sale / 出售等（与本地版工具的商家信号表对齐，
     另外不用单个“店”字判断，免得“咖啡店”这类路人帖误中）。
     没有信号的路人帖跳过、不采评论、不进结果
     （`stats.postsSkippedNonMerchant`）。
   - `--no-merchant-filter` 是旧参数，现为无操作（商家筛选默认就是关的）。
3. **评论意向预筛**：读到的评论先按意向词分类（问购买 / 问价格 /
   问运费 / 问尺码，中英双语词表与本地版工具完全一致），**默认只把带
   意向的评论写进结果**，每条保留评论带 `intentTypes`（命中的类别）；
   没意向的只计数不存。`stats.commentsSeen` 是读到的评论总数，
   `stats.commentsKeptIntent` 是其中带意向的条数，逐帖输出和结尾汇总
   都会报这两个数。
   - `--keep-all`：关掉这道筛，评论全部保留（`intentTypes` 照样标注）。
   - 兼容性：本地版分析工具是从结果的 `latestComments` 重新推导意向
     线索的，预筛后保留下来的正好全是意向评论，导入分析的口径不变，
     只是结果文件更小、更聚焦。

## 最终结果

每次运行在 `out/` 里生成两个同名对应的文件：

```
out/leads-<关键词>-<时间>.csv      ← 给人看的最终名单
out/collect-<关键词>-<时间>.json   ← 完整记录，给分析工具用
```

- **`leads-*.csv` 是最终交付物，只有两列：`用户链接,评论内容`** —— 每行一个
  意向评论者，点链接就是他的 IG 主页，第二列是他评论的原话。规则：只收带
  购买意向的评论（问价格/问购买/问运费/问尺码，`--keep-all` 时也一样只出
  意向的），商家自己评自己帖的不算，同一人同一句评论过多个帖子只算一条。
  带 UTF-8 BOM，Windows 上用 Excel 双击打开不乱码。哪怕这次 0 条，也会
  生成只有表头的文件，控制台会写明「客户名单：共 N 条」。
- `collect-*.json` 是完整记录：结构是 `{ keyword, collectedAt,
  source: "local-collector", items, stats }`，`items` 里是帖子条目和评论
  条目，形状与本地版 IG 工具的导入格式一致，直接在该工具的「任务输入」页
  导入这个 JSON 即可继续分析和出表。

结果文件里只有公开采集数据和登录账号的用户名，**不含任何密码/密钥**。

## 诚实的限制

- 这是原型：Instagram 页面结构经常改版，内嵌数据有时读不到，这时字段会
  留空，评论仍会尽量从页面上展开读取；读不到就是读不到，不假装成功。
- 话题页现在主要给热门帖，账号能见的范围决定能采的范围。
- 自动登录遇到 IG 风控验证（图片验证码等）时会按停止规则停下来，需要你
  先手动在窗口里过验证或改用 --manual 手动登录一次。
- 跑得太频、量太大仍可能触发限流甚至小号被封，所以限速和上限写死；
  小号就是消耗品，千万别拿主号试。
- 采到的只有公开信息：评论人的用户名、评论内容、时间等。没有邮箱、手机号，
  也没有任何私信/关注/点赞动作。

## 自测

```bash
npm test
```

纯本地单测（黑名单、停止页检测、解析函数、accounts.txt 解析与秘密卫生、
TOTP 的 RFC 6238 官方测试向量、会话文件转换与 0600 落盘往返、
cookies 文件夹自动扫描与秘密卫生、浏览器启动顺序与回退策略、
三道采集筛选的新鲜度判定 / 商家信号 / 意向分类），
不联网、不登录、不开真浏览器。

## 一键启动（不用敲命令）

把卖家给的 cookie 文件放进 **`cookies/` 文件夹**（**文件名随便，不用改名**，
比如就叫 `1234` 也行，扩展名有无都行），然后双击：

- Windows：`Start-Windows.bat`
- Mac：`Start-Mac.command`

第一次双击会自动装依赖（只需一次；浏览器用本机现成的 Chrome / Edge，
不另外下载，两个都没装时会先提醒你装 Chrome）。之后每次会问一句关键词，
直接回车就是 `downjacket`，想搜别的就输别的（连着的词，如 `downjacket`、
`handbag`）。启动文件只是帮你敲一句命令，真正挑文件、验登录的是脚本的
自动模式（见下一节）。结果在 `out/` 文件夹里。

注意：`cookies/` 文件夹里除说明文件外的所有文件都已被 .gitignore 排除，
不会被 git 提交；但文件就是账号钥匙，也别手动发给任何人。

## 自动模式（默认，只给 --keyword 时）

直接跑 `node collector.js --keyword downjacket`、不指定任何登录方式时，
走自动模式，按下面顺序找登录来源：

1. **`cookies/` 文件夹**：里面的卖家 cookie 文件（文件名任意、扩展名任意
   或没有扩展名）按文件名排序，在**登录核验阶段**逐个试：打开 IG 能确认
   登录上（不靠提取用户名判定，准绳是上下文里有 sessionid、不在登录页、
   没有可见密码框；用户名没识别出来也照样继续），就用那个号跑完整程；会话失效（session_expired）的报
   一下文件名、换下一个。**回退只发生在登录核验阶段**——一旦开始采集就
   不再换号。核验出的账号命中主号黑名单（`nataliem.jordan` /
   `mm8989221` / `lvlong2026`）照样立即中止整个运行（退出码 2），不会
   拿主号去试下一个。候选全部没通过时停下并列出逐个试过的文件名：
   有判失效的按 `session_expired`，全是“未能确认登录态”时按
   `not_logged_in`（附 `out/debug-*.png` 截图证据）。读不出 / 没有
   sessionid 的文件会被跳过并报文件名。
2. **根目录 `cookies.txt` / `cookies.json`**（旧一键启动的放法，仍然认）。
3. **`accounts.txt`**：里面只有一个账号时自动用它；多个账号不会自己挑，
   会列出用户名让你用 `--account` 指定（退出码 1）。

以上都没有时，脚本打印用法并退出（退出码 1），不会自己乱登。显式参数永远
优先于自动模式：`--account`、`--manual`、`--import-session`、
`--import-cookies` 给了哪个就走哪个。扫描目录可用 `--cookies-dir <目录>`
更改（默认 `./cookies`）。

## 体检 cookie 文件（--check-cookies）

文件被自动模式跳过、又不知道为什么时，不用把文件发给任何人，先跑体检：

```bash
node collector.js --check-cookies
```

它扫描 `cookies/` 文件夹（可用 `--cookies-dir <目录>` 换）和根目录的
`cookies.txt` / `cookies.json`，逐个文件只报告：文件名、认出的格式
（json数组 / json对象 / base64包装 / netscape / cookie头 / 未知）、
文件里 cookie 的**名字**清单、有没有 `sessionid`、结论（可用 / 不可用
+ 原因，如“空文件”“像Netscape格式但没有sessionid”）。**绝不打印任何
cookie 的值**，所以这份输出可以放心截图/贴出来排查。体检完就退出
（退出码 0），不登录、不采集。
