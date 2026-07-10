import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { validateDeployTarget } from "./deploy-target.mjs";

test("validateDeployTarget rejects case-variant project equality on Windows", async () => {
  await assert.rejects(
    () =>
      validateDeployTarget({
        projectRoot: "C:\\Repo\\CodePath",
        allowedRoot: "D:\\Extensions",
        targetDir: "c:\\repo\\codepath",
        platform: "win32",
        fsOps: fakeWindowsFs()
      }),
    /project directory/i
  );
});

test("validateDeployTarget rejects project descendants, filesystem roots, and sibling-prefix escapes", async () => {
  const fsOps = fakeWindowsFs();
  await assert.rejects(
    () =>
      validateDeployTarget({
        projectRoot: "C:\\Repo\\CodePath",
        allowedRoot: "C:\\Repo",
        targetDir: "C:\\Repo\\CodePath\\build\\CodePath",
        platform: "win32",
        fsOps
      }),
    /project directory/i
  );
  await assert.rejects(
    () =>
      validateDeployTarget({
        projectRoot: "C:\\Repo\\CodePath",
        allowedRoot: "D:\\Extensions",
        targetDir: "D:\\",
        platform: "win32",
        fsOps
      }),
    /filesystem root/i
  );
  await assert.rejects(
    () =>
      validateDeployTarget({
        projectRoot: "C:\\Repo\\CodePath",
        allowedRoot: "D:\\edge",
        targetDir: "D:\\edge-escape\\CodePath",
        platform: "win32",
        fsOps
      }),
    /allowed root/i
  );
});

test("validateDeployTarget rejects a deployment target that contains the project", async () => {
  await assert.rejects(
    () =>
      validateDeployTarget({
        projectRoot: "D:\\Extensions\\CodePath\\project",
        allowedRoot: "D:\\Extensions",
        targetDir: "D:\\Extensions\\CodePath",
        platform: "win32",
        fsOps: fakeWindowsFs()
      }),
    /project directory|overlap/i
  );
});

test("validateDeployTarget resolves junction targets before containment checks", async () => {
  const target = "D:\\edge\\CodePath";
  await assert.rejects(
    () =>
      validateDeployTarget({
        projectRoot: "C:\\Repo\\CodePath",
        allowedRoot: "D:\\edge",
        targetDir: target,
        platform: "win32",
        fsOps: fakeWindowsFs(new Map([[path.win32.normalize(target).toLowerCase(), "D:\\outside\\CodePath"]]))
      }),
    /allowed root/i
  );
});

test("validateDeployTarget rejects a junction target that resolves to a project ancestor", async () => {
  const allowedRoot = "D:\\edge";
  const target = "D:\\edge\\CodePath";
  const overrides = new Map([
    [path.win32.normalize(allowedRoot).toLowerCase(), "C:\\Canonical"],
    [path.win32.normalize(target).toLowerCase(), "C:\\Canonical\\CodePath"]
  ]);

  await assert.rejects(
    () =>
      validateDeployTarget({
        projectRoot: "C:\\Canonical\\CodePath\\project",
        allowedRoot,
        targetDir: target,
        platform: "win32",
        fsOps: fakeWindowsFs(overrides)
      }),
    /project directory|overlap/i
  );
});

test("validateDeployTarget accepts a canonical named child inside the allowed root", async () => {
  const result = await validateDeployTarget({
    projectRoot: "C:\\Repo\\CodePath",
    allowedRoot: "D:\\edge",
    targetDir: "D:\\edge\\CodePath",
    platform: "win32",
    fsOps: fakeWindowsFs()
  });

  assert.equal(result.targetDir.toLowerCase(), "d:\\edge\\codepath");
});

function fakeWindowsFs(realpathOverrides = new Map()) {
  return {
    async lstat() {
      return { isDirectory: () => true };
    },
    async realpath(value) {
      const normalized = path.win32.normalize(value);
      return realpathOverrides.get(normalized.toLowerCase()) ?? normalized;
    }
  };
}
