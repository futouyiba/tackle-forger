import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)?.map((entry) => Number.parseInt(entry, 16) / 255);
  assert.ok(channels && channels.length === 3, `invalid colour: ${hex}`);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test("无障碍基线提供跳至主内容、可见焦点和系统减少动态契约", async () => {
  const [styles, workbench] = await Promise.all([
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("app/Workbench.tsx", root), "utf8"),
  ]);

  assert.match(styles, /:focus-visible\s*\{[\s\S]*box-shadow: 0 0 0 6px #0b5fff;[\s\S]*outline: 3px solid #ffffff;/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /animation-duration: 0\.01ms !important/);
  assert.match(styles, /transition-duration: 0\.01ms !important/);
  assert.match(styles, /\.skip-link/);

  // The white inner ring is visible against the dark sidebar; the blue outer
  // ring stays visible where a white ring would disappear into page content.
  assert.ok(contrastRatio("#ffffff", "#111a24") >= 3);
  assert.ok(contrastRatio("#ffffff", "#192532") >= 3);
  assert.ok(contrastRatio("#0b5fff", "#ffffff") >= 3);

  const skipLinks = workbench.match(/<a className="skip-link" href="#main-content">跳至主内容<\/a>/g) ?? [];
  const mainTargets = workbench.match(/<main className="main" id="main-content" tabIndex=\{-1\}>/g) ?? [];
  assert.equal(skipLinks.length, 2, "认证前后两个 Workbench 分支都必须提供跳至主内容链接");
  assert.equal(mainTargets.length, 2, "认证前后两个 Workbench 分支都必须保留可程序聚焦的主内容目标");
});
