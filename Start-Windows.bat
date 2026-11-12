@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d %~dp0
title IG Collector

where node >nul 2>nul
if errorlevel 1 (
  echo 没找到 Node.js，请先安装 Node.js LTS（nodejs.org），装完关掉窗口重开再双击本文件。
  pause
  exit /b 1
)

if not exist node_modules (
  echo 第一次运行：正在安装依赖...
  call npm install
  if errorlevel 1 ( echo 依赖安装失败，把上面的红字截图发出来。 & pause & exit /b 1 )
)

if not exist .setup-done (
  echo 第一次运行：正在安装浏览器内核，要下载一两百兆，等它跑完...
  call npx playwright install chromium
  if errorlevel 1 ( echo 浏览器内核安装失败，把上面的红字截图发出来。 & pause & exit /b 1 )
  echo ok> .setup-done
)

set KEYWORD=downjacket
set /p KEYWORD=输入关键词（直接回车就用 downjacket）：
if "!KEYWORD!"=="" set KEYWORD=downjacket

if exist cookies.txt (
  echo 用 cookies.txt 里的会话登录，关键词：!KEYWORD!
  node collector.js --import-cookies cookies.txt --keyword !KEYWORD!
) else if exist cookies.json (
  echo 用 cookies.json 里的会话登录，关键词：!KEYWORD!
  node collector.js --import-cookies cookies.json --keyword !KEYWORD!
) else if exist accounts.txt (
  set /p ACC=没找到 cookie 文件。用 accounts.txt 登录，输入里面要用的用户名：
  if "!ACC!"=="" ( echo 没输入用户名，退出。 & pause & exit /b 1 )
  node collector.js --account !ACC! --keyword !KEYWORD!
) else (
  echo 没找到文件：请先把卖家给的 cookie 文件改名成 cookies.txt 放到这个文件夹里，
  echo 或者把 accounts.txt 放进来，再双击本文件。
)

echo.
echo 跑完了。结果在 out 文件夹里。按任意键关窗口。
pause >nul
