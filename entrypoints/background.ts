import type { PortMessage, RuntimeRequest, RuntimeResponse, Settings } from "../src/types";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/lib/defaults";
import { analyzeFeature, analyzeProject, answerQuestion, explainFile } from "../src/lib/analyzer";

export default defineBackground(() => {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "codepath") return;
    port.onMessage.addListener((message: unknown) => {
      const envelope = message as Extract<PortMessage, { request: RuntimeRequest }>;
      handleRequest(envelope.request).then((response) => {
        port.postMessage({ id: envelope.id, response } satisfies PortMessage);
      });
    });
  });

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    handleRequest(request as RuntimeRequest).then(sendResponse);
    return true;
  });
});

async function handleRequest(request: RuntimeRequest): Promise<RuntimeResponse<unknown>> {
  try {
    if (request.type === "get-settings") {
      return ok(await getSettings());
    }

    if (request.type === "save-settings") {
      await storageSet({ [SETTINGS_KEY]: request.settings });
      return ok(request.settings);
    }

    const settings = await getSettings();

    if (request.type === "analyze-project") {
      return ok(await analyzeProject(request.repo, settings));
    }

    if (request.type === "analyze-feature") {
      return ok(await analyzeFeature(request.repo, settings, request.feature));
    }

    if (request.type === "explain-file") {
      return ok(await explainFile(request.repo, settings));
    }

    if (request.type === "answer-question") {
      return ok(await answerQuestion(request.repo, settings, request.question, request.context));
    }

    return fail("Unknown request.");
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function getSettings(): Promise<Settings> {
  const stored = await storageGet(SETTINGS_KEY);
  const value = stored[SETTINGS_KEY];
  const patch = isSettingsPatch(value);
  return { ...DEFAULT_SETTINGS, ...patch };
}

function storageGet(key: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (items) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(items);
    });
  });
}

function storageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function isSettingsPatch(value: unknown): Partial<Settings> {
  if (!value || typeof value !== "object") return {};
  return value as Partial<Settings>;
}

function ok<T>(data: T): RuntimeResponse<T> {
  return { ok: true, data };
}

function fail(error: string): RuntimeResponse<never> {
  return { ok: false, error };
}
