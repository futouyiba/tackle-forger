#!/usr/bin/env bash
#
# scripts/deploy-r730.sh
# 把最新 main（或指定 ref）从本开发机推到 Dell R730 并发布。
# 场景：升级已有 current；R730 不能直连 git，代码由本机推送。
#
# 在本开发机（Git Bash / bash）上运行；远程经 SSH 在 R730 上 install + build + 切链。
#
# 必填环境变量：
#   R730_SSH     R730 上有 sudo 权限的部署账号，如 deploy@10.x.x.x 或 ~/.ssh/config 别名。
#                注意：运行账号 tackleforger 禁止交互登录，不要用它 SSH 登录。
#
# 可选环境变量（带默认）：
#   GIT_REF       要部署的 ref/SHA，默认 origin/main
#   R730_ROOT     R730 部署根，默认 /opt/tackle-forger
#   R730_SERVICE  systemd 服务名，默认 tackle-forger
#   NPM_REGISTRY  装包镜像，默认 https://registry.npmmirror.com
#                 （解决 @cloudflare/workerd、sharp、esbuild 全平台原生二进制在国内的下载卡顿）
#
# 前提：
#   - 本机可用 ssh/scp 访问 R730_SSH，且该账号能 sudo（systemctl restart、chown 需要）。
#   - R730 已按 docs/deployment/r730-production.md 完成首次初始化：
#     /opt/tackle-forger/.env.local（Node 22.x 需含 NODE_OPTIONS=--experimental-sqlite）、
#     systemd 单元、nginx 反代、data 目录均已就位。
#   - R730 上 Node >= 22.16（nvm 用户无需额外配置；其他版本管理器请自行确保非交互 ssh 下 npm 可用）。
#
# 安全边界（手册）：
#   - 本脚本只新增只读发布目录并切换 current 软链；绝不修改/覆盖 .env.local 与 data/（含 SQLite）。
#   - 回滚 = 切回旧 current 并重启；不回滚数据库。
#
# 示例：
#   R730_SSH=deploy@r730 bash scripts/deploy-r730.sh
#   R730_SSH=deploy@r730 GIT_REF=a9785df2 bash scripts/deploy-r730.sh

set -euo pipefail

: "${R730_SSH:?请设置 R730_SSH=部署账号@r730主机（需 sudo，非运行账号 tackleforger）}"
: "${GIT_REF:=origin/main}"
: "${R730_ROOT:=/opt/tackle-forger}"
: "${R730_SERVICE:=tackle-forger}"
: "${NPM_REGISTRY:=https://registry.npmmirror.com}"

# --- 0. 切到仓库根 ---
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/.."
test -f package.json || { echo "✗ 找不到 package.json，请在仓库内运行"; exit 1; }

echo "==> 1/5 拉取最新 main 并打包源码"
git fetch --quiet origin main
SHA="$(git rev-parse "$GIT_REF")"
STAMP="$(date +%Y%m%d-%H%M%S)"
REL="${STAMP}-${SHA:0:8}"
TAR="/tmp/tackle-forger-${REL}.tar.gz"
# git archive 只打包 git 追踪文件，自动排除 node_modules/.data/dist/.wrangler/.next
git archive --format=tar.gz "$SHA" -o "$TAR"
echo "    SHA=$SHA  REL=$REL  size=$(du -h "$TAR" | cut -f1)"

echo "==> 2/5 传输源码到 R730"
REMOTE_TAR="/tmp/tackle-forger-${REL}.tar.gz"
ssh "$R730_SSH" "mkdir -p '$R730_ROOT/releases/$REL'"
scp -q "$TAR" "$R730_SSH:$REMOTE_TAR"

echo "==> 3/5 远程 install + build（vinext build → dist）"
ssh "$R730_SSH" bash -s -- "$R730_ROOT" "$REL" "$REMOTE_TAR" "$NPM_REGISTRY" <<'REMOTE'
set -euo pipefail
ROOT="$1"; REL="$2"; TAR="$3"; REG="$4"
DIR="$ROOT/releases/$REL"

mkdir -p "$DIR"
tar -xzf "$TAR" -C "$DIR"
rm -f "$TAR"
cd "$DIR"

# 非交互 ssh 下补齐 nvm/node PATH
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null || true
command -v npm >/dev/null || { echo "✗ 远端找不到 npm，请在 R730 配置 Node PATH 或 nvm"; exit 1; }
echo "    node $(node -v)  npm $(npm -v)"

# CN 镜像装锁定依赖。vinext 在 devDependencies 但生产 npm run start 需要它，故不能 --omit=dev。
npm ci --registry="$REG" --fetch-timeout=600000 --fetch-retries=5
npm run build
test -d dist || { echo "✗ build 失败：dist/ 缺失"; exit 1; }
echo "REMOTE_BUILD_OK"
REMOTE

echo "==> 4/5 切 current 软链并重启服务"
ssh "$R730_SSH" bash -s -- "$R730_ROOT" "$REL" "$R730_SERVICE" <<'REMOTE'
set -euo pipefail
ROOT="$1"; REL="$2"; SVC="$3"
DIR="$ROOT/releases/$REL"

# 发布目录归属交给运行账号 tackleforger
sudo chown -R tackleforger:tackleforger "$DIR"

cd "$ROOT"
# 记录当前指向，便于回滚
PREV="$(readlink current 2>/dev/null || true)"
printf '%s\n' "$PREV" > current.prev
ln -sfn "$DIR" current

sudo systemctl restart "$SVC"
sleep 3
systemctl is-active "$SVC" >/dev/null || { echo "✗ 服务未起来，检查 journalctl -u $SVC"; exit 1; }
echo "SERVICE_ACTIVE"
REMOTE

echo "==> 5/5 验收"
ssh "$R730_SSH" "curl -s -o /dev/null -w 'session(期望401): %{http_code}\n' http://127.0.0.1:3000/api/auth/session"

rm -f "$TAR"
cat <<EOF

✔ 部署完成：$REL
  回滚：ssh $R730_SSH 'cd $R730_ROOT && ln -sfn "\$(cat current.prev)" current && sudo systemctl restart $R730_SERVICE'
  日志：ssh $R730_SSH 'journalctl -u $R730_SERVICE -n 100 --no-pager'
EOF
