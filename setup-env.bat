@echo off
:: setup-env.bat — 从主仓库硬链接 .env.local 到 worktree（修改主文件即同步）
:: 用法：在 worktree 根目录下双击运行，或 git worktree add 后执行

set "SCRIPT_DIR=%~dp0"
set "MAIN_REPO=%SCRIPT_DIR%..\..\..\.."
set "SRC=%MAIN_REPO%\.env.local"
set "DST=%SCRIPT_DIR%.env.local"

if not exist "%SRC%" (
  echo ❌ 主仓库没有 .env.local，请先在主仓库 A:\Projs\claude-tackle-forger 下创建
  pause
  exit /b 1
)

if exist "%DST%" (
  echo .env.local 已存在，跳过。
) else (
  mklink /h "%DST%" "%SRC%" >nul 2>&1
  if %errorlevel% equ 0 (
    echo ✅ 已创建硬链接到主仓库 .env.local（修改主文件自动同步）
  ) else (
    echo ⚠️ 硬链接失败，回退到拷贝...
    copy "%SRC%" "%DST%" >nul
    echo ✅ 已从主仓库拷贝 .env.local
  )
)
