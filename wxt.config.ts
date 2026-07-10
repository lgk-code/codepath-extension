import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "CodePath",
    description: "GitHub source-code guide for project ideas, feature paths, and implementation reading routes.",
    permissions: ["storage", "alarms"],
    host_permissions: [
      "https://github.com/*",
      "https://api.github.com/*",
      "https://codeload.github.com/*",
      "https://api.deepseek.com/*",
      "https://api.openai.com/*",
      "https://api.anthropic.com/*",
      "https://dashscope.aliyuncs.com/*",
      "https://dashscope-intl.aliyuncs.com/*",
      "http://localhost/*",
      "http://127.0.0.1/*"
    ],
    optional_host_permissions: ["https://*/*"],
    action: {
      default_title: "CodePath"
    }
  }
});
