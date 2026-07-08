const DEFAULT_ERROR_TEXT_LIMIT = 2000;
const DEFAULT_JSON_BYTES_LIMIT = 2 * 1024 * 1024;

const responseTimeouts = new WeakMap<Response, ReturnType<typeof setTimeout>>();
const responseDeadlines = new WeakMap<Response, { deadline: number; timeoutMs: number }>();

export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 60_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(timeoutError(timeoutMs)), timeoutMs);
  const externalSignal = init.signal;
  const abortFromExternalSignal = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) abortFromExternalSignal();
    else externalSignal.addEventListener("abort", abortFromExternalSignal, { once: true });
  }

  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal
    });
    responseTimeouts.set(response, timeout);
    responseDeadlines.set(response, { deadline: Date.now() + timeoutMs, timeoutMs });
    return response;
  } catch (error) {
    clearTimeout(timeout);
    if (isAbortError(error)) throw timeoutError(timeoutMs);
    throw error;
  } finally {
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
  }
}

export async function safeResponseText(response: Response, limit = DEFAULT_ERROR_TEXT_LIMIT): Promise<string> {
  return redactSensitiveText(await readResponseTextLimited(response, limit, { failOnLimit: false }));
}

export async function readJsonResponse<T>(response: Response, limit = DEFAULT_JSON_BYTES_LIMIT): Promise<T> {
  const text = await readResponseTextLimited(response, limit, { failOnLimit: true });
  return JSON.parse(text) as T;
}

export async function readResponseBytesLimited(response: Response, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    clearResponseTimeout(response);
    if (buffer.byteLength > limit) throw new Error(`Response body exceeded ${limit} bytes`);
    return buffer;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await readWithDeadline(response, reader);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel().catch(() => {});
        throw new Error(`Response body exceeded ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    clearResponseTimeout(response);
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readResponseTextLimited(
  response: Response,
  limit: number,
  options: { failOnLimit?: boolean } = {}
): Promise<string> {
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    clearResponseTimeout(response);
    if (buffer.byteLength > limit && options.failOnLimit) throw new Error(`Response body exceeded ${limit} bytes`);
    return decoder.decode(buffer.slice(0, limit));
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await readWithDeadline(response, reader);
      if (done) break;
      const remaining = limit - totalBytes;
      if (remaining <= 0) {
        await reader.cancel().catch(() => {});
        if (options.failOnLimit) throw new Error(`Response body exceeded ${limit} bytes`);
        break;
      }

      if (value.byteLength > remaining) {
        text += decoder.decode(value.slice(0, remaining), { stream: true });
        await reader.cancel().catch(() => {});
        if (options.failOnLimit) throw new Error(`Response body exceeded ${limit} bytes`);
        break;
      }

      totalBytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    clearResponseTimeout(response);
  }
}

export function clearResponseTimeout(response: Response): void {
  const timeout = responseTimeouts.get(response);
  if (timeout) clearTimeout(timeout);
  responseTimeouts.delete(response);
  responseDeadlines.delete(response);
}

export async function readResponseStreamChunk(
  response: Response,
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return readWithDeadline(response, reader);
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, "[redacted-api-key]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{12,}\b/g, "[redacted-github-token]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{12,}\b/g, "[redacted-github-token]")
    .replace(/(authorization|x-api-key)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1: [redacted]");
}

async function readWithDeadline(response: Response, reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
  const deadline = responseDeadlines.get(response);
  if (!deadline) return reader.read();

  const remainingMs = deadline.deadline - Date.now();
  if (remainingMs <= 0) {
    await reader.cancel().catch(() => {});
    throw timeoutError(deadline.timeoutMs);
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          reject(timeoutError(deadline.timeoutMs));
        }, remainingMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (timedOut) await reader.cancel().catch(() => {});
  }
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`Request timed out after ${timeoutMs}ms`);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
