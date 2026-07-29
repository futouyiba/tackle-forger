import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageJson = JSON.parse(readFileSync(
  new URL("../package.json", import.meta.url),
  "utf8",
));
const startDev = readFileSync(
  new URL("../scripts/start-dev.ps1", import.meta.url),
  "utf8",
);
const loginGuide = readFileSync(
  new URL("../docs/deployment/feishu-enterprise-login.md", import.meta.url),
  "utf8",
);

test("vinext dev uses its supported CLI port and the worktree helper forwards overrides", () => {
  const help = execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("../node_modules/vinext/dist/cli.js", import.meta.url)),
      "dev",
      "--help",
    ],
    { encoding: "utf8" },
  );

  assert.match(help, /-p, --port <port>/u);
  assert.equal(packageJson.scripts.dev, "vinext dev -p 3456");
  assert.match(startDev, /\[int\]\$Port = 3456/u);
  assert.match(startDev, /& npm\.cmd run dev -- -p \$Port/u);
  assert.match(startDev, /\$vinextCli' dev -p \$Port"/u);
  assert.match(loginGuide, /npm run dev[\s\S]*?`3456`/u);
  assert.match(loginGuide, /start-dev\.ps1 -Port <端口>[\s\S]*?最后一个[\s\S]*?`-p`/u);
  assert.match(loginGuide, /127\.0\.0\.1:3456\/api\/auth\/feishu\/callback/u);
  assert.match(loginGuide, /127\.0\.0\.1:3457\/api\/auth\/feishu\/callback/u);
});
