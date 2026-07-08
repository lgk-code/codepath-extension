import assert from "node:assert/strict";
import { test } from "node:test";
import { githubFileUrl } from "./linkPaths";

test("githubFileUrl uses the analyzed branch override when provided", () => {
  assert.equal(
    githubFileUrl({ owner: "acme", repo: "demo", pageType: "repo" }, "src/app.ts", "develop"),
    "https://github.com/acme/demo/blob/develop/src/app.ts"
  );
});

test("githubFileUrl rejects unsafe relative path segments", () => {
  assert.throws(
    () => githubFileUrl({ owner: "acme", repo: "demo", pageType: "repo" }, "../secret.ts"),
    /Unsafe repository path/
  );
});
