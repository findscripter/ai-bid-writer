@echo off
cd /d "%~dp0"
chcp 65001 >nul
title AI写标书助手 - 单端口模式
color 0B

echo ================================================
echo      AI写标书助手 - 单端口集成启动
echo ================================================
echo.

where python >nul 2>&1
if %errorlevel% neq 0 (
    echo Python 未安装或不在 PATH 中
    pause
    exit /b 1
)

echo 检查前端构建文件...
if not exist backend\static\index.html (
    echo 前端构建文件不存在，正在构建...
    echo.

    echo [1/2] 构建前端...
    cd frontend
    call npm run build
    if %errorlevel% neq 0 (
        echo 前端构建失败
        pause
        exit /b 1
    )
    cd ..

    echo [2/2] 复制构建文件...
    python -c "import shutil; shutil.copytree('frontend/build', 'backend/static', dirs_exist_ok=True)"
    echo 构建完成
    echo.
) else (
    echo 前端构建文件已存在
    echo.
)

echo 启动集成服务...
echo 服务地址: http://localhost:8000
echo API文档: http://localhost:8000/docs
echo.
echo 前后端已集成，无CORS问题
echo ================================================

cd backend
python run.py

echo.
echo 👋 服务已关闭
pause