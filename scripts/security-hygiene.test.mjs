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

test("secret editor is opened and mutated only through the background", () => {
  const editor = read("public/secret-input.js");
  const config = read("wxt.config.ts");
  const background = read("entrypoints/background.ts");
  const sidebar = read("src/components/Sidebar.tsx");

  assert.doesNotMatch(config, /web_accessible_resources/);
  assert.match(config, /frame-ancestors 'none'/);
  assert.match(editor, /chrome\.runtime\.sendMessage/);
  assert.doesNotMatch(editor, /chrome\.storage\.local/);
  assert.match(background, /chrome\.windows\.create/);
  assert.match(background, /request\.type === "update-secret"/);
  assert.match(background, /settingsStore\.updateSecret/);
  assert.match(background, /settingsStore\.saveNonSecret/);
  assert.match(background, /updateStreamingMetadataIfCurrent/);
  assert.match(sidebar, /const \[draftDirty, setDraftDirty\] = useState\(false\)/);
  assert.match(sidebar, /if \(draftDirty\) return;[\s\S]{0,180}settingsDraftWithoutSecrets\(props\.settings\)/);
  assert.match(sidebar, /function updateDraft\(next: Settings\)[\s\S]{0,100}setDraftDirty\(true\)/);
  assert.match(sidebar, /requestedDraftRevision[\s\S]{0,600}draftRevisionRef\.current !== requestedDraftRevision/);
});

test("prompt version fingerprints every source-backed analysis prompt", () => {
  const analyzer = read("src/lib/analyzer.ts");
  const fingerprint = analyzer.slice(analyzer.indexOf("function createPromptVersion"), analyzer.indexOf("function analysisBasis"));

  for (const name of [
    "analyzeProjectAttempt",
    "analyzeFeatureAttempt",
    "generateSkillBlueprintAttempt",
    "explainFileAttempt",
    "answerQuestionAttempt",
    "needsSourceLookup",
    "detectProjectProfile",
    "summarizeTree",
    "buildStructuralContext",
    "pickEntryCandidates",
    "summarizeImportantDirs",
    "buildImportRelations",
    "formatImportRelation",
    "resolveImportPath",
    "normalizePath",
    "formatSnippets",
    "systemPrompt",
    "projectPrompt",
    "fullSourceProjectPrompt",
    "skillBlueprintPrompt"
  ]) {
    assert.match(fingerprint, new RegExp(`${name}\\.toString\\(\\)`));
  }
  assert.match(fingerprint, /stringHash64/);
});

test("streaming UI updates are scoped to the active repository run", () => {
  const sidebar = read("src/components/Sidebar.tsx");
  assert.match(sidebar, /runIdRef/);
  assert.match(sidebar, /repoKey === repoStateKey\(repoRef\.current\)/);
  assert.match(sidebar, /isRepoStateCurrent\(repoKey, location\.href\)/);
  assert.match(sidebar, /current\.runId === runId/);
  assert.doesNotMatch(sidebar, /markStreamFallback|stream-fallback|fallbackReason/);
  const background = read("entrypoints/background.ts");
  const analyzer = read("src/lib/analyzer.ts");
  assert.match(background, /onModelError: \(error\) => post\(\{ id: envelope\.id, event: "stream-error", error \}\)/);
  assert.match(analyzer, /const result = await chatAuto[\s\S]{0,180}onModelDone/);
  assert.match(analyzer, /catch \(error\)[\s\S]{0,180}onModelError/);
});

test("navigation events are signals and repository requests are sender-scoped", () => {
  const content = read("entrypoints/content.tsx");
  const sidebar = read("src/components/Sidebar.tsx");
  const background = read("entrypoints/background.ts");

  assert.match(content, /new CustomEvent\("codepath:url-change"\)/);
  assert.doesNotMatch(content, /codepath:url-change[\s\S]{0,80}detail:/);
  assert.match(sidebar, /parseGithubUrl\(location\.href\)/);
  assert.match(background, /port\.sender/);
  assert.match(background, /sender\?\.tab\?\.url/);
  assert.match(background, /validateRequestLocation/);
});

test("repository operations are not replayed through sendMessage after a port attempt", () => {
  const sidebar = read("src/components/Sidebar.tsx");
  assert.match(sidebar, /canFallbackLocallyBeforeDispatch\(request, portError\.dispatched\)/);
  assert.doesNotMatch(sidebar, /function sendViaMessage/);
  assert.doesNotMatch(sidebar, /request\.type === "save-settings"[\s\S]{0,180}setExtensionSettings/);
  assert.match(sidebar, /validateRequestLocation\(request, location\.href\)/);
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

test("Windows development guide publishes topic branches for review", () => {
  const guide = read("docs/DEVELOPMENT.md");
  assert.match(guide, /git push -u origin HEAD/);
  assert.match(guide, /Pull Request/);
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

test("secret scanner uses the shared behavioral pattern module without a size bypass", () => {
  const scanner = read("scripts/scan-secrets.mjs");
  assert.match(scanner, /secret-patterns\.mjs/);
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

test("Edge deployment validates canonical targets and promotes a staged directory", () => {
  const deploy = read("scripts/deploy-edge.mjs");
  assert.match(deploy, /validateDeployTarget/);
  assert.match(deploy, /replaceDirectoryAtomic/);
  assert.doesNotMatch(deploy, /rm\(resolvedTargetDir/);
});
