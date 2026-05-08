import React from "react";
import { createRoot } from "react-dom/client";
import { parseGithubUrl } from "../src/lib/githubUrl";
import { Sidebar } from "../src/components/Sidebar";
import "../src/styles.css";

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

  let host = document.getElementById("codepath-root");
  if (!host) {
    host = document.createElement("div");
    host.id = "codepath-root";
    document.body.appendChild(host);
    createRoot(host).render(<Sidebar />);
  }

  window.dispatchEvent(new CustomEvent("codepath:url-change", { detail: repo }));
}
