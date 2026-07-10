import type { Settings } from "../types";
import { inferProviderFromBaseUrl, normalizeBaseUrl } from "./aiClient";
import { DEFAULT_SETTINGS } from "./defaults";

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const OPENAI_DEFAULT_MODEL = "gpt-4.1-mini";

type Environment = Record<string, string | undefined>;

export function resolveMcpSettings(env: Environment): Settings {
  const codePathNamespaceUsed = hasValue(env.CODEPATH_PROVIDER) || hasValue(env.CODEPATH_API_KEY) || hasValue(env.CODEPATH_BASE_URL) || hasValue(env.CODEPATH_MODEL);
  const openAiNamespaceUsed = hasValue(env.OPENAI_API_KEY) || hasValue(env.OPENAI_BASE_URL) || hasValue(env.OPENAI_MODEL);

  if (codePathNamespaceUsed && openAiNamespaceUsed) {
    throw new Error("Mixed credential namespaces are not allowed; configure either CODEPATH_* or OPENAI_* model settings.");
  }

  const githubToken = firstValue(env.CODEPATH_GITHUB_TOKEN, env.GITHUB_TOKEN, DEFAULT_SETTINGS.githubToken);
  if (openAiNamespaceUsed) {
    return {
      ...DEFAULT_SETTINGS,
      provider: "openai",
      apiKey: firstValue(env.OPENAI_API_KEY),
      baseUrl: normalizeBaseUrl(firstValue(env.OPENAI_BASE_URL, OPENAI_DEFAULT_BASE_URL)),
      model: firstValue(env.OPENAI_MODEL, OPENAI_DEFAULT_MODEL),
      githubToken
    };
  }

  const baseUrl = normalizeBaseUrl(firstValue(env.CODEPATH_BASE_URL, DEFAULT_SETTINGS.baseUrl));
  const explicitProvider = env.CODEPATH_PROVIDER?.trim();
  const provider = explicitProvider === "anthropic" || explicitProvider === "openai" ? explicitProvider : inferProviderFromBaseUrl(baseUrl);
  return {
    ...DEFAULT_SETTINGS,
    provider,
    apiKey: firstValue(env.CODEPATH_API_KEY),
    baseUrl,
    model: firstValue(env.CODEPATH_MODEL, DEFAULT_SETTINGS.model),
    githubToken
  };
}

function hasValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function firstValue(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}
