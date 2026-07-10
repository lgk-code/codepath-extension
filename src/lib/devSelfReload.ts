export const DEV_RELOAD_MARKER_PATH = "codepath-dev-reload.json";
export const DEV_RELOAD_SCHEMA_VERSION = 1;

export type ExtensionInstallType = "admin" | "development" | "normal" | "sideload" | "other" | string;

export type DevReloadMarker = {
  schemaVersion: typeof DEV_RELOAD_SCHEMA_VERSION;
  buildId: string;
  deployedAt: string;
};

export function parseDevReloadMarker(value: unknown): DevReloadMarker | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DevReloadMarker>;
  if (candidate.schemaVersion !== DEV_RELOAD_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(candidate.buildId)) return null;
  if (!isIsoDate(candidate.deployedAt)) return null;
  return {
    schemaVersion: DEV_RELOAD_SCHEMA_VERSION,
    buildId: candidate.buildId,
    deployedAt: candidate.deployedAt
  };
}

export function shouldReloadForDevMarker(input: {
  currentBuildId: string;
  installType: ExtensionInstallType;
  marker: DevReloadMarker | null;
}): boolean {
  return input.installType === "development" && Boolean(input.marker) && input.marker?.buildId !== input.currentBuildId;
}

export async function checkDevSelfReloadOnce(input: {
  currentBuildId: string;
  getInstallType: () => Promise<ExtensionInstallType>;
  readMarker: () => Promise<DevReloadMarker | null>;
  reload: () => void;
}): Promise<boolean> {
  const installType = await input.getInstallType();
  const marker = await input.readMarker();
  if (!shouldReloadForDevMarker({ currentBuildId: input.currentBuildId, installType, marker })) return false;
  input.reload();
  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
