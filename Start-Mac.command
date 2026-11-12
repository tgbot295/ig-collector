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

if [ ! -f .setup-done ]; then
  echo "第一次运行：正在安装浏览器内核，要下载一两百兆，等它跑完..."
  npx playwright install chromium || { echo "浏览器内核安装失败，把上面的红字截图发出来。"; read -r -p "按回车关闭..." _; exit 1; }
  echo ok > .setup-done
fi

read -r -p "输入关键词（直接回车就用 downjacket）：" KEYWORD
[ -z "$KEYWORD" ] && KEYWORD=downjacket

if [ -f cookies.txt ]; then
  echo "用 cookies.txt 里的会话登录，关键词：$KEYWORD"
  node collector.js --import-cookies cookies.txt --keyword "$KEYWORD"
elif [ -f cookies.json ]; then
  echo "用 cookies.json 里的会话登录，关键词：$KEYWORD"
  node collector.js --import-cookies cookies.json --keyword "$KEYWORD"
elif [ -f accounts.txt ]; then
  read -r -p "没找到 cookie 文件。用 accounts.txt 登录，输入里面要用的用户名：" ACC
  [ -z "$ACC" ] && { echo "没输入用户名，退出。"; read -r -p "按回车关闭..." _; exit 1; }
  node collector.js --account "$ACC" --keyword "$KEYWORD"
else
  echo "没找到文件：请先把卖家给的 cookie 文件改名成 cookies.txt 放到这个文件夹里，"
  echo "或者把 accounts.txt 放进来，再双击本文件。"
fi

echo
echo "跑完了。结果在 out 文件夹里。"
read -r -p "按回车关闭..." _
