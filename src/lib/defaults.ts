import type { Settings } from "../types";

export const DEFAULT_SETTINGS: Settings = {
  provider: "qwen",
  apiKey: "",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen-plus",
  githubToken: "",
  streamingMode: "untested"
};

export const SETTINGS_KEY = "codepath-settings";
