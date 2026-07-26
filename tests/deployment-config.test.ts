import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

test("构建路径只保留 Node/Vinext，不再声明云端部署适配", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts.build, "vinext build");
  assert.equal("build:vercel" in packageJson.scripts, false);
  assert.equal("nitro" in packageJson.devDependencies, false);
  assert.equal("@cloudflare/vite-plugin" in packageJson.devDependencies, false);
  assert.equal("wrangler" in packageJson.devDependencies, false);

  const viteConfig = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(viteConfig, /plugins: \[vinext\(\)\]/);
  assert.doesNotMatch(viteConfig, /cloudflare|nitro|vercel|sites/i);

  for (const relativePath of ["../vercel.json", "../.openai/hosting.json", "../worker/index.ts"]) {
    await assert.rejects(stat(new URL(relativePath, import.meta.url)));
  }
});

test("R730 模板精确监听所有 IPv4 接口，并将直连与 Nginx 登录来源设为互斥模式", async () => {
  const [service, nginx, deployScript, acceptance, handbook] = await Promise.all([
    readFile(new URL("../deploy/tackle-forger.service", import.meta.url), "utf8"),
    readFile(new URL("../deploy/nginx-tackle-forger.conf.example", import.meta.url), "utf8"),
    readFile(new URL("../scripts/deploy-r730.sh", import.meta.url), "utf8"),
    readFile(new URL("../docs/deployment/phase-one-acceptance.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/deployment/r730-production.md", import.meta.url), "utf8"),
  ]);
  assert.match(service, /--hostname 0\.0\.0\.0 --port 13000/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:13000/);
  for (const source of [acceptance, handbook]) {
    assert.match(source, /(?:全部|所有) IPv4 接口/);
    assert.match(source, /实际可达范围.*网卡、路由、防火墙和 NAT/);
    assert.match(source, /http:\/\/<R730_RFC1918_IP>:13000/);
    assert.match(source, /FEISHU_ALLOW_INSECURE_HTTP=true/);
    assert.match(source, /不得.*同时.*登录来源/);
  }
  assert.match(deployScript, /R730_PORT:=13000/);
  assert.match(deployScript, /api\/auth\/session/);
  assert.match(deployScript, /status" = "401"/);
  assert.match(deployScript, /rollback_release/);
  assert.match(deployScript, /test -n "\$PREV"/);
  assert.match(deployScript, /ln -sfn "\$PREV" "\$ROOT\/current"/);
  assert.match(deployScript, /--add-virtual-file="\$\{RELEASE_COMMIT_MARKER\}:\$\{RELEASE_COMMIT_CONTENT\}"/);
  assert.match(deployScript, /\.tackle-forger-release-commit/);
  assert.match(deployScript, /EXPECTED_SHA/);
});

test("生产验收以服务账号运行，使环境、数据、证据与 Cookie 所有权检查绑定同一 UID", async () => {
  const [acceptance, handbook] = await Promise.all([
    readFile(new URL("../docs/deployment/phase-one-acceptance.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/deployment/r730-production.md", import.meta.url), "utf8"),
  ]);
  for (const source of [acceptance, handbook]) {
    assert.match(source, /sudo -u tackleforger env PATH=\/usr\/local\/bin:\/usr\/bin:\/bin/);
  }
  assert.match(acceptance, /由服务账号 `tackleforger` 拥有的 `0600` 普通文件/);
  assert.match(acceptance, /Cookie 也必须由 `tackleforger` 创建并保持 `0600`/);
});
