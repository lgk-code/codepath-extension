import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDevSelfReloadOnce, parseDevReloadMarker, shouldReloadForDevMarker } from "./devSelfReload";

test("parseDevReloadMarker accepts a valid marker", () => {
  const marker = parseDevReloadMarker({
    schemaVersion: 1,
    buildId: "dev-2026-07-09-self-reload-v1",
    deployedAt: "2026-07-09T13:00:00.000Z"
  });

  assert.deepEqual(marker, {
    schemaVersion: 1,
    buildId: "dev-2026-07-09-self-reload-v1",
    deployedAt: "2026-07-09T13:00:00.000Z"
  });
});

test("parseDevReloadMarker rejects malformed markers", () => {
  assert.equal(parseDevReloadMarker(null), null);
  assert.equal(parseDevReloadMarker({ schemaVersion: 2, buildId: "x", deployedAt: "2026-07-09T13:00:00.000Z" }), null);
  assert.equal(parseDevReloadMarker({ schemaVersion: 1, buildId: "", deployedAt: "2026-07-09T13:00:00.000Z" }), null);
  assert.equal(parseDevReloadMarker({ schemaVersion: 1, buildId: "x", deployedAt: "not-a-date" }), null);
});

test("shouldReloadForDevMarker reloads only a development install with a newer marker", () => {
  const marker = {
    schemaVersion: 1 as const,
    buildId: "dev-2026-07-09-self-reload-v1",
    deployedAt: "2026-07-09T13:00:00.000Z"
  };

  assert.equal(
    shouldReloadForDevMarker({
      currentBuildId: "dev-2026-07-08-cache-freshness-v2",
      installType: "development",
      marker
    }),
    true
  );
  assert.equal(
    shouldReloadForDevMarker({
      currentBuildId: "dev-2026-07-09-self-reload-v1",
      installType: "development",
      marker
    }),
    false
  );
  assert.equal(
    shouldReloadForDevMarker({
      currentBuildId: "dev-2026-07-08-cache-freshness-v2",
      installType: "normal",
      marker
    }),
    false
  );
  assert.equal(
    shouldReloadForDevMarker({
      currentBuildId: "dev-2026-07-08-cache-freshness-v2",
      installType: "development",
      marker: null
    }),
    false
  );
});

test("checkDevSelfReloadOnce wires install type and marker before reloading", async () => {
  const marker = {
    schemaVersion: 1 as const,
    buildId: "dev-2026-07-09-self-reload-v1",
    deployedAt: "2026-07-09T13:00:00.000Z"
  };
  let reloadCount = 0;

  const reloaded = await checkDevSelfReloadOnce({
    currentBuildId: "dev-2026-07-08-cache-freshness-v2",
    getInstallType: async () => "development",
    readMarker: async () => marker,
    reload: () => {
      reloadCount += 1;
    }
  });

  assert.equal(reloaded, true);
  assert.equal(reloadCount, 1);

  reloadCount = 0;
  assert.equal(
    await checkDevSelfReloadOnce({
      currentBuildId: "dev-2026-07-08-cache-freshness-v2",
      getInstallType: async () => "normal",
      readMarker: async () => marker,
      reload: () => {
        reloadCount += 1;
      }
    }),
    false
  );
  assert.equal(reloadCount, 0);

  assert.equal(
    await checkDevSelfReloadOnce({
      currentBuildId: "dev-2026-07-09-self-reload-v1",
      getInstallType: async () => "development",
      readMarker: async () => marker,
      reload: () => {
        reloadCount += 1;
      }
    }),
    false
  );
  assert.equal(reloadCount, 0);
});
