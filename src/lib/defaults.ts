import type { Settings } from "../types";

export const DEFAULT_SETTINGS: Settings = {
  provider: "openai",
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  githubToken: "",
  maxOutputTokens: 4096,
  streamingMode: "untested"
};

export const SETTINGS_KEY = "codepath-settings";
