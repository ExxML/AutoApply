// Minimal in-memory chrome.storage / chrome.runtime mock for unit tests.
type Listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

export function installChromeMock() {
  const listeners: Listener[] = [];
  const area = (name: string) => {
    let data: Record<string, unknown> = {};
    return {
      data: () => data,
      async get(keys?: string | string[] | null) {
        if (keys == null) return structuredClone(data);
        const ks = typeof keys === "string" ? [keys] : keys;
        const out: Record<string, unknown> = {};
        for (const k of ks) if (k in data) out[k] = structuredClone(data[k]);
        return out;
      },
      async set(values: Record<string, unknown>) {
        const changes: Record<string, chrome.storage.StorageChange> = {};
        for (const [k, v] of Object.entries(values)) {
          changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
          data[k] = structuredClone(v);
        }
        listeners.forEach((l) => l(changes, name));
      },
      async remove(keys: string | string[]) {
        for (const k of typeof keys === "string" ? [keys] : keys) delete data[k];
      },
      async clear() {
        data = {};
      },
    };
  };
  const mock = {
    storage: {
      local: area("local"),
      session: area("session"),
      onChanged: {
        addListener: (l: Listener) => listeners.push(l),
        removeListener: (l: Listener) => listeners.splice(listeners.indexOf(l), 1),
      },
    },
    runtime: { sendMessage: async () => undefined, getURL: (p: string) => p, id: "test" },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = mock;
  return mock;
}
