type Scheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type StreamBatcher = {
  push(text: string): void;
  flush(): void;
};

const defaultScheduler: Scheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export function createStreamBatcher(flushText: (text: string) => void, intervalMs = 40, scheduler: Scheduler = defaultScheduler): StreamBatcher {
  let pending = "";
  let timer: unknown;

  const flush = () => {
    if (timer !== undefined) {
      scheduler.clearTimeout(timer);
      timer = undefined;
    }
    if (!pending) return;
    const text = pending;
    pending = "";
    flushText(text);
  };

  return {
    push(text) {
      if (!text) return;
      pending += text;
      if (timer === undefined) timer = scheduler.setTimeout(flush, intervalMs);
    },
    flush
  };
}
