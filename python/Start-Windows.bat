@echo off
chcp 936 >nul
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo 没找到 Python。请先安装 Python 3.11 以上版本，安装时勾选 Add Python to PATH。
  echo 下载地址：https://www.python.org/downloads/
  pause
  exit /b 1
)
if not exist ".setup-done-py" (
  echo 首次运行：正在安装依赖（只有 playwright 一个包）…
  py -m pip install -r requirements.txt
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
  echo done> ".setup-done-py"
)
echo.
echo 使用前：把卖家给的 cookie 文件放进本目录的 cookies 文件夹（文件名随便）。
echo 本工具用你电脑上现成的 Google Chrome，不下载浏览器内核。
echo.
set /p KW=请输入关键词（直接回车 = downjacket）：
if "%KW%"=="" set KW=downjacket
py collector.py --keyword "%KW%"
pause
