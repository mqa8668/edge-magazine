// Minimal in-memory fakes so lib code that expects Workers bindings can run
// under plain node vitest. Only the methods the code under test touches exist.

export interface FakeKV {
  store: Map<string, string>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
}

export function fakeKV(): FakeKV {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list(opts) {
      const prefix = opts?.prefix ?? "";
      return {
        keys: [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((name) => ({ name })),
      };
    },
  };
}

// A Bindings-shaped object with a fake KV; extend per test. Cast to the code's
// Bindings at the call site (the real type carries D1/R2 we do not need here).
export function fakeEnv(over: Record<string, unknown> = {}) {
  return { CACHE_KV: fakeKV(), ...over };
}
