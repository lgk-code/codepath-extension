import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "CodePath",
    description: "GitHub source-code guide for project ideas, feature paths, and implementation reading routes.",
    permissions: ["storage"],
    host_permissions: [
      "https://github.com/*",
      "https://api.github.com/*",
      "https://codeload.github.com/*",
      "https://dashscope.aliyuncs.com/*",
      "https://dashscope-intl.aliyuncs.com/*",
      "https://*/*",
      "http://localhost/*",
      "http://127.0.0.1/*"
    ],
    web_accessible_resources: [
      {
        resources: ["bridge.js"],
        matches: ["https://github.com/*"]
      }
    ],
    action: {
      default_title: "CodePath"
    }
  }
});
