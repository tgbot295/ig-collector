#!/bin/bash
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 Node.js，请先安装 Node.js LTS（nodejs.org），装完再双击本文件。"
  read -r -p "按回车关闭..." _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "第一次运行：正在安装依赖..."
  npm install || { echo "依赖安装失败，把上面的红字截图发出来。"; read -r -p "按回车关闭..." _; exit 1; }
fi

# 浏览器用本机现成的 Chrome / Edge，不再另外下载内核
# （Playwright 自带 Chromium 的下载源在国内会被墙，403 装不上）。
# 只做软检查：两个都没装才拦下来提醒。
if [ ! -d "/Applications/Google Chrome.app" ] && [ ! -d "/Applications/Microsoft Edge.app" ]; then
  echo "先装一个 Google Chrome，这个脚本用你电脑上现成的浏览器，不再另外下载。"
  read -r -p "按回车关闭..." _
  exit 1
fi

# 有登录来源就打开图形控制台（关键词在网页里填，点「开始采集」才跑，
# 登录走脚本的自动模式，和命令行一致）；没有登录来源时保持原提示：
# 先放好 cookie 文件再双击，别进控制台空转。
FOUND=
if [ -d cookies ]; then
  for f in cookies/*; do
    [ -f "$f" ] || continue
    case "$(basename "$f")" in
      README*) ;;
      *) FOUND=1 ;;
    esac
  done
fi
[ -f cookies.txt ] && FOUND=1
[ -f cookies.json ] && FOUND=1
[ -f accounts.txt ] && FOUND=1

if [ -n "$FOUND" ]; then
  echo "正在打开图形控制台：http://127.0.0.1:3212"
  echo "在网页里填关键词（一行一个）、点「开始采集」。用完关掉这个终端窗口即可停掉控制台。"
  ( sleep 2; open "http://127.0.0.1:3212" ) &
  node collector.js --gui
else
  echo "先把卖家给的 cookie 文件放进 cookies 文件夹（文件名随便），再双击本文件。"
fi

echo
read -r -p "按回车关闭..." _
