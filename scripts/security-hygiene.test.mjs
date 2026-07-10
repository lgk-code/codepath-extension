import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

test("content script does not inject a page-context settings bridge", () => {
  const content = read("entrypoints/content.tsx");
  assert.doesNotMatch(content, /bridge\.js|injectBridge|codepath:page-request/);
});

test("GitHub page sidebar does not render secret input values", () => {
  const sidebar = read("src/components/Sidebar.tsx");
  assert.doesNotMatch(sidebar, /type="password"/);
  assert.doesNotMatch(sidebar, /apiKeyDraft|githubTokenDraft/);
});

test("streaming UI updates are scoped to the active repository run", () => {
  const sidebar = read("src/components/Sidebar.tsx");
  assert.match(sidebar, /runIdRef/);
  assert.match(sidebar, /repoKey === repoStateKey\(repoRef\.current\)/);
  assert.match(sidebar, /current\.runId === runId/);
});

test("manifest does not request arbitrary HTTPS host access", () => {
  const config = read("wxt.config.ts");
  const hostPermissions = config.match(/host_permissions:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  assert.doesNotMatch(hostPermissions, /"https:\/\/\*\/\*"/);
});

test("quality gate includes the test suite", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts.test, /--test/);
  assert.match(pkg.scripts.quality, /npm run test/);
});

test("MCP tools do not expose GitHub token as a tool argument", () => {
  const source = read("scripts/codepath-mcp.ts");
  const registerToolBlocks = source.split("server.registerTool").slice(1);
  assert.ok(registerToolBlocks.length > 0, "expected MCP tool registrations");
  for (const block of registerToolBlocks) {
    const schemaText = block.slice(0, block.indexOf("async"));
    assert.doesNotMatch(schemaText, /githubToken/);
  }
});

test("secret scanner covers GitHub token variants and WSL/private drive paths", () => {
  const scanner = read("scripts/scan-secrets.mjs");
  assert.match(scanner, /gh\[osru\]_/);
  assert.match(scanner, /mnt\\\/c\\\/Users/);
  assert.match(scanner, /[A-Z]:\\\\/);
  assert.doesNotMatch(scanner, /stat\.size\s*>\s*1_000_000/);
});

test("zip fallback applies limits before full download and extraction", () => {
  const source = read("src/lib/zipGithubClient.ts");
  assert.match(source, /readResponseBytesLimited\(response,\s*MAX_ZIP_BYTES\)/);
  assert.match(source, /filter\(file\)/);
  assert.match(source, /file\.originalSize > MAX_ZIP_ENTRY_BYTES/);
});

test("dev self reload is marker-driven and gated to development installs", () => {
  const background = read("entrypoints/background.ts");
  const config = read("wxt.config.ts");
  assert.match(config, /"alarms"/);
  assert.match(background, /checkDevSelfReloadOnce/);
  assert.match(background, /chrome\.management\?\.getSelf/);
  assert.match(background, /DEV_RELOAD_MARKER_PATH/);
  assert.match(background, /chrome\.runtime\.reload\(\)/);
});
