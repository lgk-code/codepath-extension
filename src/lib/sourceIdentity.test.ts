import assert from "node:assert/strict";
import { test } from "node:test";
import { digestZipEntries } from "./sourceIdentity";

test("digestZipEntries length-frames paths and content", async () => {
  const first = await digestZipEntries([{ path: "a", content: new TextEncoder().encode(":b") }]);
  const second = await digestZipEntries([{ path: "a:", content: new TextEncoder().encode("b") }]);

  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("digestZipEntries is stable across entry order", async () => {
  const first = await digestZipEntries([
    { path: "b.ts", content: new Uint8Array([2]) },
    { path: "a.ts", content: new Uint8Array([1]) }
  ]);
  const second = await digestZipEntries([
    { path: "a.ts", content: new Uint8Array([1]) },
    { path: "b.ts", content: new Uint8Array([2]) }
  ]);

  assert.equal(first, second);
});
