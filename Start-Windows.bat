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

rem 浏览器用本机现成的 Chrome / Edge，不再另外下载内核
rem （Playwright 自带 Chromium 的下载源在国内会被墙，403 装不上）。
rem 这里只做软检查：两个都没装才拦下来提醒。
set BROWSER_FOUND=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set BROWSER_FOUND=1
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set BROWSER_FOUND=1
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set BROWSER_FOUND=1
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set BROWSER_FOUND=1
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set BROWSER_FOUND=1
if not defined BROWSER_FOUND (
  echo 先装一个 Google Chrome，这个脚本用你电脑上现成的浏览器，不再另外下载。
  pause
  exit /b 1
)

set KEYWORD=downjacket
set /p KEYWORD=输入关键词（直接回车就用 downjacket）：
if "!KEYWORD!"=="" set KEYWORD=downjacket

rem 自动模式：cookies 文件夹里有非说明文件、或根目录有 cookies.txt / cookies.json、
rem 或有 accounts.txt，就直接让脚本自己挑登录来源（脚本的自动模式会处理，
rem 包括 accounts.txt 多个账号时在终端里让你选）。
set FOUND=
if exist cookies (
  for %%F in (cookies\*) do (
    set "FN=%%~nxF"
    if /i not "!FN:~0,6!"=="README" set FOUND=1
  )
)
if exist cookies.txt set FOUND=1
if exist cookies.json set FOUND=1
if exist accounts.txt set FOUND=1

if defined FOUND (
  echo 自动模式启动，关键词：!KEYWORD!（脚本会自动读取 cookies 文件夹里的会话文件）
  node collector.js --keyword !KEYWORD!
) else (
  echo 先把卖家给的 cookie 文件放进 cookies 文件夹（文件名随便），再双击本文件。
)

echo.
echo 跑完了。结果在 out 文件夹里。按任意键关窗口。
pause >nul
