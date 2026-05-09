import React from "react";
import { createRoot } from "react-dom/client";
import { parseGithubUrl } from "../src/lib/githubUrl";
import { Sidebar } from "../src/components/Sidebar";
import "../src/styles.css";

const CONTENT_BUILD = "dev-2026-05-09-qa-timing";
const ROOT_ID = "codepath-dev-root";
const LEGACY_ROOT_ID = "codepath-root";

export default defineContentScript({
  matches: ["https://github.com/*/*"],
  main() {
    injectBridge();
    mount();
    let lastUrl = location.href;
    setInterval(() => {
      if (lastUrl !== location.href) {
        lastUrl = location.href;
        mount();
      }
    }, 800);
  }
});

function injectBridge() {
  if (document.getElementById("codepath-bridge")) return;
  const script = document.createElement("script");
  script.id = "codepath-bridge";
  script.src = chrome.runtime.getURL("bridge.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

function mount() {
  const repo = parseGithubUrl(location.href);
  if (!repo) return;

  const legacyHost = document.getElementById(LEGACY_ROOT_ID);
  if (legacyHost) legacyHost.remove();

  let host = document.getElementById(ROOT_ID);
  if (host && host.dataset.codepathBuild !== CONTENT_BUILD) {
    host.remove();
    host = null;
  }

  if (!host) {
    host = document.createElement("div");
    host.id = ROOT_ID;
    host.dataset.codepathBuild = CONTENT_BUILD;
    document.body.appendChild(host);
    createRoot(host).render(<Sidebar />);
  }

  window.dispatchEvent(new CustomEvent("codepath:url-change", { detail: repo }));
}
