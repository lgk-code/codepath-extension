import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));

test("lockfile excludes reviewed vulnerable development dependency ranges", () => {
  assertVersionAtLeast("node_modules/vite", "8.0.16");
  assertVersionAtLeast("node_modules/esbuild", "0.28.1");
  assertVersionAtLeast("node_modules/@babel/core", "8.0.0");
  assertVersionAtLeast("node_modules/hono", "4.12.25");
  assertVersionAtLeast("node_modules/fx-runner", "1.5.0");
  assertVersionAtLeast("node_modules/shell-quote", "1.8.4");
  assertVersionAtLeast("node_modules/tmp", "0.2.6");
  assertVersionAtLeast("node_modules/uuid", "11.1.1");
  assertVersionAtLeast("node_modules/qs", "6.15.2");
});

function assertVersionAtLeast(packagePath, minimum) {
  const actual = lock.packages?.[packagePath]?.version;
  assert.ok(actual, `${packagePath} should exist in package-lock.json`);
  assert.ok(compareVersions(actual, minimum) >= 0, `${packagePath} ${actual} must be at least ${minimum}`);
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
