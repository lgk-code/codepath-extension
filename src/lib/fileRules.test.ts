import assert from "node:assert/strict";
import { test } from "node:test";
import { isUsefulPath } from "./fileRules";

test("isUsefulPath ignores generated and dependency directories at any depth", () => {
  assert.equal(isUsefulPath("packages/web/node_modules/react/index.js"), false);
  assert.equal(isUsefulPath("apps/site/dist/main.ts"), false);
  assert.equal(isUsefulPath("services/api/coverage/report.json"), false);
  assert.equal(isUsefulPath("src/components/Sidebar.tsx"), true);
});
