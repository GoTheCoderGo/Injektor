/**
 * Async context without an npm dependency.
 * Node and Bun use the built-in AsyncLocalStorage when it can be loaded
 * without a static import. The browser fallback only scopes synchronous
 * calls; async continuations must explicitly reenter their captured store.
 */
export interface AsyncLocalStorageLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): R;
}

type BuiltinModule = {
  getBuiltinModule?: (id: string) => { AsyncLocalStorage?: new () => AsyncLocalStorageLike<unknown> };
};

export function createAsyncLocalStorage<T>(): AsyncLocalStorageLike<T> {
  const Native = loadNativeAsyncLocalStorage();
  if (Native) return new Native();
  return new SynchronousLocalStorage<T>();
}

function loadNativeAsyncLocalStorage(): (new <T>() => AsyncLocalStorageLike<T>) | undefined {
  const proc = (globalThis as { process?: BuiltinModule }).process;
  if (typeof proc?.getBuiltinModule !== "function") return undefined;
  try {
    const hooks = proc.getBuiltinModule("node:" + "async_hooks");
    const Ctor = hooks?.AsyncLocalStorage;
    if (typeof Ctor === "function") return Ctor as new <T>() => AsyncLocalStorageLike<T>;
  } catch {
    return undefined;
  }
  return undefined;
}

/** Synchronous context fallback that never leaks a pending async call's store. */
export class SynchronousLocalStorage<T> implements AsyncLocalStorageLike<T> {
  #store: T | undefined;

  getStore(): T | undefined {
    return this.#store;
  }

  run<R>(store: T, callback: () => R): R {
    const previous = this.#store;
    this.#store = store;
    try {
      return callback();
    } finally {
      this.#store = previous;
    }
  }
}
