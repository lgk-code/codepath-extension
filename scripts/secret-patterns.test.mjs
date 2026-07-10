import assert from "node:assert/strict";
import { test } from "node:test";
import { scanSensitiveText } from "./secret-patterns.mjs";

test("secret patterns detect temporary AWS credentials", () => {
  const temporaryAccessKey = "AS" + "IA" + "A".repeat(16);
  const findings = scanSensitiveText(`key=${temporaryAccessKey}`);

  assert.ok(findings.some((finding) => finding.name === "AWS access key"));
});

test("secret patterns detect private Windows paths case-insensitively", () => {
  const privatePath = "c:" + "\\Users\\example\\repo";
  const findings = scanSensitiveText(privatePath);

  assert.ok(findings.some((finding) => finding.name === "Windows user private path"));
});

test("secret patterns detect GitHub token variants", () => {
  const oauthToken = "gh" + "o_" + "A".repeat(20);
  const findings = scanSensitiveText(oauthToken);

  assert.ok(findings.some((finding) => finding.name === "GitHub OAuth/server/user/refresh token"));
});

test("secret patterns do not report ordinary project text", () => {
  assert.deepEqual(scanSensitiveText("CodePath scans public GitHub repositories."), []);
});
