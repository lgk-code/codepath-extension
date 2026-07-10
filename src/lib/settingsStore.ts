import type { Settings } from "../types";

type SettingsStoreDependencies = {
  load: () => Promise<Settings>;
  save: (settings: Settings) => Promise<void>;
  normalize: (settings: Settings) => Settings;
};

type StreamingMetadata = Pick<Settings, "supportsStreaming" | "streamingMode">;

export function createSettingsStore(dependencies: SettingsStoreDependencies) {
  let mutationQueue: Promise<void> = Promise.resolve();

  async function read(): Promise<Settings> {
    await mutationQueue;
    return dependencies.normalize(await dependencies.load());
  }

  function mutate(update: (current: Settings) => Settings | undefined): Promise<{ settings: Settings; changed: boolean }> {
    const operation = mutationQueue.then(async () => {
      const current = dependencies.normalize(await dependencies.load());
      const candidate = update(current);
      if (!candidate) return { settings: current, changed: false };
      const next = dependencies.normalize(candidate);
      await dependencies.save(next);
      return { settings: next, changed: true };
    });
    mutationQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  return {
    read,
    async saveNonSecret(requested: Settings): Promise<Settings> {
      const result = await mutate((current) => {
        const candidate = dependencies.normalize({
          ...requested,
          apiKey: current.apiKey,
          githubToken: current.githubToken
        });
        const connectionChanged = modelConnectionIdentity(candidate) !== modelConnectionIdentity(current);
        return {
          ...candidate,
          supportsStreaming: connectionChanged ? false : current.supportsStreaming,
          streamingMode: connectionChanged ? "untested" : current.streamingMode
        };
      });
      return result.settings;
    },
    async updateSecret(field: "apiKey" | "githubToken", value: string): Promise<Settings> {
      const result = await mutate((current) => ({
        ...current,
        [field]: value,
        ...(field === "apiKey" && value !== current.apiKey ? { supportsStreaming: false, streamingMode: "untested" as const } : {})
      }));
      return result.settings;
    },
    async updateStreamingMetadataIfCurrent(tested: Settings, metadata: StreamingMetadata): Promise<boolean> {
      const result = await mutate((current) => {
        if (modelConnectionIdentity(current) !== modelConnectionIdentity(dependencies.normalize(tested))) return undefined;
        return { ...current, ...metadata };
      });
      return result.changed;
    }
  };
}

function modelConnectionIdentity(settings: Settings): string {
  return JSON.stringify([
    settings.provider,
    settings.apiKey,
    settings.baseUrl,
    settings.model,
    settings.maxOutputTokens ?? null
  ]);
}
