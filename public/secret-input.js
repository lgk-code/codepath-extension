const SETTINGS_KEY = "codepath-settings";
const fields = {
  apiKey: {
    title: "模型 API Key",
    description: "这个窗口运行在扩展页面中，不把密钥写入 GitHub 页面 DOM。",
    label: "模型 API Key"
  },
  githubToken: {
    title: "GitHub Token",
    description: "这个窗口运行在扩展页面中，不把 Token 写入 GitHub 页面 DOM。",
    label: "GitHub Token"
  }
};

const params = new URLSearchParams(location.search);
const field = params.get("field") === "githubToken" ? "githubToken" : "apiKey";
const copy = fields[field];

const title = document.querySelector("#title");
const description = document.querySelector("#description");
const label = document.querySelector("#field-label");
const input = document.querySelector("#secret");
const status = document.querySelector("#status");
const saveButton = document.querySelector("#save");
const clearButton = document.querySelector("#clear");
const cancelButton = document.querySelector("#cancel");

title.textContent = copy.title;
description.textContent = copy.description;
label.textContent = copy.label;

saveButton.addEventListener("click", () => updateSecret(input.value.trim()));
clearButton.addEventListener("click", () => updateSecret(""));
cancelButton.addEventListener("click", () => window.close());

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void updateSecret(input.value.trim());
  if (event.key === "Escape") window.close();
});

async function updateSecret(value) {
  saveButton.disabled = true;
  clearButton.disabled = true;
  status.textContent = "正在保存...";
  try {
    const stored = await storageGet(SETTINGS_KEY);
    const current = stored && typeof stored === "object" ? stored : {};
    await storageSet({ [SETTINGS_KEY]: { ...current, [field]: value } });
    status.textContent = value ? "已保存。" : "已清除。";
    input.value = "";
    setTimeout(() => window.close(), 600);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    saveButton.disabled = false;
    clearButton.disabled = false;
  }
}

function storageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (items) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message || "Storage read failed"));
      else resolve(items[key]);
    });
  });
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message || "Storage write failed"));
      else resolve();
    });
  });
}
