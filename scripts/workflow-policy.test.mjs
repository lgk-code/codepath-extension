import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const workflowPaths = [".github/workflows/ci.yml", ".github/workflows/release.yml"];

test("GitHub Actions references are pinned to immutable commit SHAs", () => {
  for (const workflowPath of workflowPaths) {
    const source = fs.readFileSync(workflowPath, "utf8");
    const references = [...source.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/g)];
    assert.ok(references.length > 0, `${workflowPath} should use actions`);
    for (const reference of references) {
      assert.match(reference[2], /^[0-9a-f]{40}$/i, `${reference[1]} in ${workflowPath} must be pinned`);
    }
  }
});

test("release workflow verifies tag provenance against full main history", () => {
  const release = fs.readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(release, /fetch-depth:\s*0/);
  assert.match(release, /npm run verify:release/);
  assert.match(release, /refs\/remotes\/origin\/main/);
});
