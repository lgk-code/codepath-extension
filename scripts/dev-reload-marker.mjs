export const DEV_RELOAD_MARKER_PATH = "codepath-dev-reload.json";
export const DEV_RELOAD_SCHEMA_VERSION = 1;

export function extractBuildId(source) {
  const match =
    source.match(/const\s+CONTENT_BUILD\s*=\s*"([^"]+)"/) ??
    source.match(/export\s+const\s+CODEPATH_BUILD\s*=\s*"([^"]+)"/);
  if (!match?.[1]) {
    throw new Error("Unable to find CodePath build id.");
  }
  return match[1];
}

export function createDevReloadMarker(buildId, deployedAt = new Date()) {
  if (!buildId || typeof buildId !== "string") {
    throw new Error("A non-empty build id is required.");
  }
  return {
    schemaVersion: DEV_RELOAD_SCHEMA_VERSION,
    buildId,
    deployedAt: deployedAt.toISOString()
  };
}

export function parseDevReloadMarker(value) {
  if (!value || typeof value !== "object") return null;
  if (value.schemaVersion !== DEV_RELOAD_SCHEMA_VERSION) return null;
  if (typeof value.buildId !== "string" || !value.buildId) return null;
  if (typeof value.deployedAt !== "string" || !Number.isFinite(Date.parse(value.deployedAt))) return null;
  return {
    schemaVersion: value.schemaVersion,
    buildId: value.buildId,
    deployedAt: value.deployedAt
  };
}
