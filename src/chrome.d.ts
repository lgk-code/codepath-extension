declare const chrome: {
  runtime: {
    lastError?: { message?: string };
    connect(connectInfo?: { name?: string }): ChromePort;
    onConnect: {
      addListener(callback: (port: ChromePort) => void): void;
    };
    onMessage: {
      addListener(
        callback: (
          request: unknown,
          sender: unknown,
          sendResponse: (response?: unknown) => void
        ) => boolean | void
      ): void;
    };
    onInstalled: {
      addListener(callback: (details: { reason: string }) => void): void;
    };
    sendMessage(message: unknown, callback: (response: unknown) => void): void;
    getURL(path: string): string;
    reload(): void;
  };
  alarms?: {
    create(name: string, alarmInfo: { periodInMinutes?: number; delayInMinutes?: number }): void;
    clear?(name: string): void;
    onAlarm: {
      addListener(callback: (alarm: { name: string }) => void): void;
    };
  };
  management?: {
    getSelf?(): Promise<{ installType?: string }>;
  };
  tabs?: {
    query(queryInfo: { url?: string | string[] }, callback: (tabs: Array<{ id?: number }>) => void): void;
    reload(tabId: number): void;
  };
  storage: {
    local: {
      get(key: string, callback: (items: Record<string, unknown>) => void): void;
      set(items: Record<string, unknown>, callback: () => void): void;
    };
  };
};

type ChromePort = {
  name: string;
  onMessage: {
    addListener(callback: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(callback: () => void): void;
  };
  disconnect(): void;
  postMessage(message: unknown): void;
};
