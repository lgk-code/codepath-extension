import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyRelease } from "./verify-release.mjs";

const taggedSha = "a".repeat(40);
const mainSha = "b".repeat(40);
const headSha = taggedSha;

test("verifyRelease accepts a matching version tag whose commit is on main", async () => {
  const result = await verifyRelease({
    tag: "v1.2.3",
    packageVersion: "1.2.3",
    taggedSha,
    headSha,
    mainSha,
    tagObjectType: "tag",
    isAncestor: async (candidate, main) => candidate === taggedSha && main === mainSha
  });

  assert.deepEqual(result, { tag: "v1.2.3", taggedSha, headSha, mainSha, tagObjectType: "tag" });
});

test("verifyRelease rejects mismatched tags and unmerged commits", async () => {
  await assert.rejects(
    () => verifyRelease({ tag: "v1.2.4", packageVersion: "1.2.3", taggedSha, headSha, mainSha, tagObjectType: "tag", isAncestor: async () => true }),
    /does not match package version/i
  );
  await assert.rejects(
    () => verifyRelease({ tag: "v1.2.3", packageVersion: "1.2.3", taggedSha, headSha, mainSha, tagObjectType: "tag", isAncestor: async () => false }),
    /not contained in main/i
  );
});

test("verifyRelease rejects malformed commit identities", async () => {
  await assert.rejects(
    () => verifyRelease({ tag: "v1.2.3", packageVersion: "1.2.3", taggedSha: "short", headSha, mainSha, tagObjectType: "tag", isAncestor: async () => true }),
    /commit SHA/i
  );
});

test("verifyRelease rejects a lightweight tag and a checkout that is not the tagged commit", async () => {
  await assert.rejects(
    () => verifyRelease({ tag: "v1.2.3", packageVersion: "1.2.3", taggedSha, headSha, mainSha, tagObjectType: "commit", isAncestor: async () => true }),
    /annotated tag/i
  );
  await assert.rejects(
    () =>
      verifyRelease({
        tag: "v1.2.3",
        packageVersion: "1.2.3",
        taggedSha,
        headSha: "c".repeat(40),
        mainSha,
        tagObjectType: "tag",
        isAncestor: async () => true
      }),
    /checked out HEAD/i
  );
});
