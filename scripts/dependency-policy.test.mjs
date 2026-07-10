import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { minVersion, satisfies } from "semver";

const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const projectNodeFloor = minVersion(pkg.engines?.node ?? "");

test("lockfile excludes reviewed vulnerable development dependency ranges", () => {
  assertVersionAtLeast("node_modules/vite", "8.0.16");
  assertEsbuildOutsideReviewedVulnerableRange();
  assertVersionAtLeast("node_modules/hono", "4.12.25");
  assertVersionAtLeast("node_modules/fx-runner", "1.5.0");
  assertAllInstalledAtLeast("shell-quote", "1.8.4");
  assertVersionAtLeast("node_modules/tmp", "0.2.6");
  assertVersionAtLeast("node_modules/uuid", "11.1.1");
  assertVersionAtLeast("node_modules/qs", "6.15.2");
});

test("the project Node engine floor satisfies every installed package engine", () => {
  assert.ok(projectNodeFloor, "package.json should declare a valid Node engine floor");
  for (const [packagePath, installed] of Object.entries(lock.packages ?? {})) {
    if (!installed.engines?.node) continue;
    assert.ok(
      satisfies(projectNodeFloor, installed.engines.node),
      `${packagePath || "project"} requires Node ${installed.engines.node}, outside project floor ${projectNodeFloor}`
    );
  }
});

test("React tooling uses a Babel version compatible with its declared range and the project Node floor", () => {
  const babel = lock.packages?.["node_modules/@babel/core"];
  const reactPlugin = lock.packages?.["node_modules/@vitejs/plugin-react"];
  assert.ok(babel?.version, "@babel/core should exist in package-lock.json");
  assert.ok(reactPlugin?.dependencies?.["@babel/core"], "@vitejs/plugin-react should declare @babel/core");
  assert.ok(satisfies(babel.version, reactPlugin.dependencies["@babel/core"]), `${babel.version} must satisfy ${reactPlugin.dependencies["@babel/core"]}`);
  assert.ok(satisfies(projectNodeFloor, babel.engines?.node ?? "*"), `@babel/core ${babel.version} must support the project Node floor ${projectNodeFloor}`);
});

test("esbuild satisfies the direct ranges declared by tsx and WXT", () => {
  const esbuildVersion = lock.packages?.["node_modules/esbuild"]?.version;
  assert.ok(esbuildVersion, "esbuild should exist in package-lock.json");
  for (const packagePath of ["node_modules/tsx", "node_modules/wxt"]) {
    const range = lock.packages?.[packagePath]?.dependencies?.esbuild;
    assert.ok(range, `${packagePath} should declare esbuild`);
    assert.ok(satisfies(esbuildVersion, range), `esbuild ${esbuildVersion} must satisfy ${packagePath} ${range}`);
  }
});

function assertVersionAtLeast(packagePath, minimum) {
  const actual = lock.packages?.[packagePath]?.version;
  assert.ok(actual, `${packagePath} should exist in package-lock.json`);
  assert.ok(compareVersions(actual, minimum) >= 0, `${packagePath} ${actual} must be at least ${minimum}`);
}

function assertAllInstalledAtLeast(packageName, minimum) {
  const entries = Object.entries(lock.packages ?? {}).filter(([packagePath]) => packagePath.endsWith(`node_modules/${packageName}`));
  assert.ok(entries.length > 0, `${packageName} should exist in package-lock.json`);
  for (const [packagePath, installed] of entries) {
    assert.ok(compareVersions(installed.version, minimum) >= 0, `${packagePath} ${installed.version} must be at least ${minimum}`);
  }
}

function assertEsbuildOutsideReviewedVulnerableRange() {
  const actual = lock.packages?.["node_modules/esbuild"]?.version;
  assert.ok(actual, "node_modules/esbuild should exist in package-lock.json");
  assert.equal(satisfies(actual, ">=0.27.3 <0.28.1"), false, `esbuild ${actual} must stay outside GHSA-g7r4-m6w7-qqqr`);
}

function compareVersions(left, right) {
  const leftParts = left.split(/[.-]/).slice(0, 3).map(Number);
  const rightParts = right.split(/[.-]/).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
