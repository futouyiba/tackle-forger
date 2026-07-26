@echo off
:: init-dev-env.bat — 初始化本地开发环境
:: 支持三种来源：共享盘路径 / 私有 Git 仓库 / 本地模板

setlocal enabledelayedexpansion

:: ── 配置区：这里填内部共享位置 ──
:: 方案A：公司共享盘路径
set "SHARED_DRIVE=\\192.168.1.xxx\tackle-forger-dev\env\"
:: 方案B：私有 Git 仓库
set "PRIVATE_REPO=git@private.git.server:tackle-forger/dev-secrets.git"
:: ───────────────────────────────────

set "ENV_FILE=%~dp0.env.local"
set "EXAMPLE_FILE=%~dp0.env.local.example"

echo === Tackle Forger 本地开发环境初始化 ===

:: 1. 尝试从共享盘拷贝
if exist "%SHARED_DRIVE%.env.local" (
  echo ✅ 从共享盘 %SHARED_DRIVE% 拷贝 .env.local
  copy "%SHARED_DRIVE%.env.local" "%ENV_FILE%" >nul
  goto :done
)

:: 2. 尝试从私有 Git 仓库拉取
where git >nul 2>&1
if %errorlevel% equ 0 (
  set "CLONE_DIR=%TEMP%\tf-dev-secrets"
  git clone --depth 1 "%PRIVATE_REPO%" "!CLONE_DIR!" 2>nul
  if exist "!CLONE_DIR!\.env.local" (
    echo ✅ 从私有仓库拉取 .env.local
    copy "!CLONE_DIR!\.env.local" "%ENV_FILE%" >nul
    rd /s /q "!CLONE_DIR!" 2>nul
    goto :done
  )
)

:: 3. 从模板创建
if exist "%EXAMPLE_FILE%" (
  echo ⚠️  未找到共享/私有源，从模板创建 .env.local
  echo ⚠️  请手动填入 FEISHU_APP_SECRET 和 FEISHU_SESSION_SECRET
  copy "%EXAMPLE_FILE%" "%ENV_FILE%" >nul
  echo 模板已复制到 .env.local，请编辑填入真实值后重新运行。
  pause
  exit /b 0
)

echo ❌ 模板文件也找不到，请手动创建 .env.local
exit /b 1

:done
echo ✅ .env.local 就绪
exit /b 0
