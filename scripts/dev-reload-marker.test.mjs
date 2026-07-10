import assert from "node:assert/strict";
import { test } from "node:test";
import { DEV_RELOAD_MARKER_PATH, DEV_RELOAD_SCHEMA_VERSION, createDevReloadMarker, extractBuildId, parseDevReloadMarker } from "./dev-reload-marker.mjs";
import { DEV_RELOAD_MARKER_PATH as RUNTIME_MARKER_PATH, DEV_RELOAD_SCHEMA_VERSION as RUNTIME_SCHEMA_VERSION } from "../src/lib/devSelfReload";

test("extractBuildId reads the CodePath build constant", () => {
  assert.equal(
    extractBuildId('const CONTENT_BUILD = "dev-2026-07-09-self-reload-v1";'),
    "dev-2026-07-09-self-reload-v1"
  );
  assert.equal(
    extractBuildId('export const CODEPATH_BUILD = "dev-2026-07-09-self-reload-v1";'),
    "dev-2026-07-09-self-reload-v1"
  );
});

test("extractBuildId rejects sources without a CodePath build constant", () => {
  assert.throws(() => extractBuildId("const OTHER_BUILD = \"dev-x\";"), /Unable to find CodePath build id/);
});

test("createDevReloadMarker records a schema version, build id, and deployment time", () => {
  const marker = createDevReloadMarker("dev-2026-07-09-self-reload-v1", new Date("2026-07-09T13:00:00.000Z"));

  assert.deepEqual(marker, {
    schemaVersion: 1,
    buildId: "dev-2026-07-09-self-reload-v1",
    deployedAt: "2026-07-09T13:00:00.000Z"
  });
});

test("parseDevReloadMarker validates staged marker data", () => {
  const marker = createDevReloadMarker("dev-test", new Date("2026-07-09T13:00:00.000Z"));
  assert.deepEqual(parseDevReloadMarker(marker), marker);
  assert.equal(parseDevReloadMarker({ ...marker, schemaVersion: 2 }), null);
  assert.equal(parseDevReloadMarker({ ...marker, deployedAt: "invalid" }), null);
});

test("deploy marker constants match runtime marker constants", () => {
  assert.equal(DEV_RELOAD_MARKER_PATH, RUNTIME_MARKER_PATH);
  assert.equal(DEV_RELOAD_SCHEMA_VERSION, RUNTIME_SCHEMA_VERSION);
});
