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
    sendMessage(message: unknown, callback: (response: unknown) => void): void;
    getURL(path: string): string;
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
  postMessage(message: unknown): void;
};
