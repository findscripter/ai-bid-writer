@echo off
cd /d "%~dp0"
chcp 65001 >nul
title AI写标书助手 - 单端口模式
color 0B

echo ================================================
echo      AI写标书助手 - 单端口集成启动
echo ================================================
echo.

rem 需要指定某个 Python 时，先设置环境变量 AI_BID_PYTHON（例如 Anaconda 里的 python.exe）
set "PY=python"
if defined AI_BID_PYTHON set "PY=%AI_BID_PYTHON%"

rem 端口默认 8000；被别的程序占用时，先设置环境变量 AI_BID_PORT（例如 8001）
set "PORT=8000"
if defined AI_BID_PORT set "PORT=%AI_BID_PORT%"

"%PY%" --version >nul 2>&1
if errorlevel 1 (
    echo 找不到 Python：%PY%
    echo 请安装 Python 3.9 及以上，或者用环境变量 AI_BID_PYTHON 指定 python.exe 的完整路径
    pause
    exit /b 1
)

echo 检查前端构建文件...
"%PY%" build_frontend.py
if errorlevel 1 (
    echo.
    echo 前端构建失败，服务没有启动
    pause
    exit /b 1
)
echo.

echo 启动集成服务...
echo 服务地址: http://localhost:%PORT%
echo API文档: http://localhost:%PORT%/docs
echo.
echo 前后端已集成，无CORS问题
echo ================================================

cd backend
"%PY%" run.py

echo.
echo 服务已关闭
pause
