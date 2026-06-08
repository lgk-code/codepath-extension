import type { Settings } from "../types";

export const DEFAULT_SETTINGS: Settings = {
  provider: "openai",
  apiKey: "",
  baseUrl: "",
  model: "",
  githubToken: "",
  streamingMode: "untested"
};

export const SETTINGS_KEY = "codepath-settings";
