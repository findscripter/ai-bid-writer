"""构建前端并放到 backend/static（后端同端口托管）。

    python build_frontend.py           前端源码比上次构建新才重新构建
    python build_frontend.py --force   无论如何都重新构建
    python build_frontend.py --check   只检查是否需要构建（需要时退出码为 1）

找不到 npm 但 frontend/node_modules 已经装好时，直接用 node 调用构建脚本。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FRONTEND = ROOT / "frontend"
BUILD_DIR = FRONTEND / "build"
STATIC_DIR = ROOT / "backend" / "static"
STAMP = STATIC_DIR / "index.html"

WATCHED = ["src", "public", "package.json", "tailwind.config.js", "postcss.config.js", "tsconfig.json"]


def newest_source_mtime() -> float:
    newest = 0.0
    for name in WATCHED:
        path = FRONTEND / name
        if path.is_file():
            newest = max(newest, path.stat().st_mtime)
        elif path.is_dir():
            for item in path.rglob("*"):
                if item.is_file():
                    newest = max(newest, item.stat().st_mtime)
    return newest


def is_stale() -> bool:
    if not STAMP.exists():
        return True
    return newest_source_mtime() > STAMP.stat().st_mtime


def build_command() -> list:
    npm = shutil.which("npm")
    if npm:
        return [npm, "run", "build"]
    node = shutil.which("node")
    script = FRONTEND / "node_modules" / "react-scripts" / "bin" / "react-scripts.js"
    if node and script.exists():
        return [node, str(script), "build"]
    if not node:
        raise SystemExit("没有找到 Node.js。请先安装 Node.js 18 或更高版本（https://nodejs.org）。")
    raise SystemExit("没有找到 npm，前端依赖也还没有安装。请先在 frontend 目录执行 npm install。")


def build() -> None:
    if not (FRONTEND / "node_modules").is_dir():
        npm = shutil.which("npm")
        if not npm:
            raise SystemExit("前端依赖还没有安装，且找不到 npm。请安装 Node.js（自带 npm）后在 frontend 目录执行 npm install。")
        print("正在安装前端依赖（首次需要几分钟）...")
        subprocess.run([npm, "install"], cwd=str(FRONTEND), check=True)

    print("正在构建前端（约一两分钟）...")
    env = dict(os.environ)
    env.setdefault("GENERATE_SOURCEMAP", "false")
    subprocess.run(build_command(), cwd=str(FRONTEND), check=True, env=env)

    if not (BUILD_DIR / "index.html").exists():
        raise SystemExit("构建结束了，但没有找到 frontend/build/index.html。")
    if STATIC_DIR.exists():
        shutil.rmtree(STATIC_DIR)
    shutil.copytree(BUILD_DIR, STATIC_DIR)
    # 让时间戳晚于全部源码，下次启动不会误判为需要重新构建
    os.utime(STAMP, None)
    print(f"前端已构建并复制到 {STATIC_DIR}")


def main() -> int:
    args = set(sys.argv[1:])
    if "--check" in args:
        stale = is_stale()
        print("需要重新构建前端" if stale else "前端构建是最新的")
        return 1 if stale else 0
    if "--force" in args or is_stale():
        try:
            build()
        except subprocess.CalledProcessError as exc:
            print(f"前端构建失败（退出码 {exc.returncode}）")
            return 1
    else:
        print("前端构建是最新的，跳过构建。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
