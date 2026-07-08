import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchWithTimeout, readResponseBytesLimited, safeResponseText } from "./fetchUtils";

test("safeResponseText caps streaming error bodies without buffering the full response", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(5000)));
      },
      cancel() {
        cancelled = true;
      }
    })
  );

  const text = await safeResponseText(response, 100);

  assert.equal(text.length, 100);
  assert.equal(cancelled, true);
});

test("readResponseBytesLimited rejects oversized streaming bodies before completion", async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16));
        controller.enqueue(new Uint8Array(16));
      }
    })
  );

  await assert.rejects(readResponseBytesLimited(response, 20), /Response body exceeded 20 bytes/);
});

test("fetchWithTimeout also bounds body reads", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise(() => {});
        }
      })
    );

  try {
    const response = await fetchWithTimeout("https://example.invalid", {}, 10);
    await assert.rejects(safeResponseText(response), /Request timed out after 10ms/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
