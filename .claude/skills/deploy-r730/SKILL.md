---
name: deploy-r730
description: Build and deploy a git ref to the intranet Dell R730 (192.168.1.157, service port 13000) via scripts/deploy-r730.sh, then verify and roll back if needed. Use when asked to deploy/release/发布/部署/上线 tackle-forger to the R730 or 内网服务器.
---

# deploy-r730 — 发布到 Dell R730

把指定 git ref 构建并发布到内网 Dell R730 生产机。

## 参数

- **GIT_REF** = 本次 skill 调用传入的参数(args);为空时默认 `origin/main`。可以是分支名(`origin/main`、`fix/xxx`)、tag、或 commit SHA。

## 前提(先检查,再执行)

1. **SSH 已免密到 R730**(本机 `~/.ssh/id_ed25519` → `root@192.168.1.157` 已配)。先跑一次验证(用 Bash 工具,`BatchMode` 必须成功、不能提示密码):
   ```bash
   ssh -o BatchMode=yes -o ConnectTimeout=8 root@192.168.1.157 "hostname"
   ```
   期望直接返回 `kf-idc-devops-frontend`。若提示密码或 `Permission denied`:**停止,不要交互输密码**,让用户在终端跑一次(会提示输入密码):
   ```
   ! ssh-copy-id -i ~/.ssh/id_ed25519.pub root@192.168.1.157
   ```
   完成后重试。
2. **构建链路是 vinext**:`npm run build` 产出 `dist/`,`npm run start` 运行。**绝不推送到 `sites` remote**(只推 `origin`)。

## 执行

从仓库根(含 `scripts/deploy-r730.sh` 的目录)用 Bash 工具运行(把 `<GIT_REF>` 替换为上面的值):

```bash
R730_SSH=root@192.168.1.157 GIT_REF=<GIT_REF> bash scripts/deploy-r730.sh
```

脚本 `set -euo pipefail`,逐步打印 `==> 1/5` … `==> 5/5`。建议用较长 timeout(如 600000ms),远程 `npm ci + npm run build` 较慢。

## 跟踪 5 个阶段

- **1/5** `git fetch origin main` → `git archive` 打包指定 SHA。
- **2/5** `scp` 上传 tar 包。
- **3/5** 远程 `npm ci`(走 npmmirror 镜像)+ `npm run build`,校验 `dist/`。
- **4/5** `chown` 给运行账号 `tackleforger` → `ln -sfn` 切 `current` → `sudo systemctl restart tackle-forger` → 校验 `is-active`。
- **5/5** 远程本地 `curl http://127.0.0.1:3000/api/auth/session`(期望 401)。

任一阶段非零退出即失败。**报告失败的阶段编号和最后几行输出**,并给出取日志命令:
```bash
ssh root@192.168.1.157 'journalctl -u tackle-forger -n 80 --no-pager'
```

## 成功后:从本机外部验收端口 13000

脚本 5/5 验收的是 R730 **本地 3000**;对外暴露的是 **13000**(nginx 反代)。部署结束后**额外**从本机验证:
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.1.157:13000/api/auth/session
```
判读:`401` = 服务正常未登录(最常见);`503` = 启动中/短暂不可用,等几秒重试;`000` = **13000 没有服务监听**,部署不算完成。

## 报告与回滚

完成后给出:部署的 REL(`<时间戳>-<SHA前8位>`)、外部验收状态码、回滚命令(只切软链 + 重启,**不回滚数据库**):
```bash
ssh root@192.168.1.157 'cd /opt/tackle-forger && ln -sfn "$(cat current.prev)" current && sudo systemctl restart tackle-forger'
```
