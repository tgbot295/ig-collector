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

# 自动模式：cookies 文件夹里有非说明文件、或根目录有 cookies.txt / cookies.json、
# 或有 accounts.txt，就直接让脚本自己挑登录来源（脚本的自动模式会处理，
# 包括 accounts.txt 多个账号时在终端里让你选）。
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
  echo "自动模式启动，关键词：$KEYWORD（脚本会自动读取 cookies 文件夹里的会话文件）"
  node collector.js --keyword "$KEYWORD"
else
  echo "先把卖家给的 cookie 文件放进 cookies 文件夹（文件名随便），再双击本文件。"
fi

echo
echo "跑完了。结果在 out 文件夹里。"
read -r -p "按回车关闭..." _
