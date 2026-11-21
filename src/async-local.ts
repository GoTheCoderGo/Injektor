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

type Slot<T> = { store?: T };

type NativeModule = {
  AsyncLocalStorage?: new <T>() => AsyncLocalStorageLike<T>;
  types?: { isPromise(value: unknown): boolean };
};

type BuiltinLoader = (id: string) => NativeModule | undefined;

/** Keep a factory's ambient store alive until its native promise settles. */
export function createFactoryStorage<T>(): AsyncLocalStorageLike<T> {
  const proc = (globalThis as { process?: {
    versions?: { node?: string };
    getBuiltinModule?: BuiltinLoader;
  } }).process;
  // Older Node releases reach this code through the package's CommonJS runtime.
  const nativeRequire = proc?.versions?.node && typeof require === "function" ? require : undefined;
  const load: BuiltinLoader | undefined = typeof proc?.getBuiltinModule === "function"
    ? proc.getBuiltinModule.bind(proc)
    : nativeRequire;
  if (load) {
    try {
      const Native = load("node:async_hooks")?.AsyncLocalStorage;
      const isPromise = load("node:util")?.types?.isPromise;
      if (Native && isPromise) return new NativeFactoryStorage(new Native<Slot<T>>(), isPromise);
    } catch {
      // A browser process shim may expose a loader without Node built-ins.
    }
  }
  return new SynchronousLocalStorage<T>();
}

class NativeFactoryStorage<T> implements AsyncLocalStorageLike<T> {
  constructor(
    private readonly storage: AsyncLocalStorageLike<Slot<T>>,
    private readonly isPromise: (value: unknown) => boolean,
  ) {}

  getStore(): T | undefined {
    return this.storage.getStore()?.store;
  }

  run<R>(store: T, callback: () => R): R {
    // Clearing the slot releases the graph even if a timer keeps its async resource alive.
    const slot: Slot<T> = { store };
    const close = () => { slot.store = undefined; };
    try {
      const value = this.storage.run(slot, callback);
      // Node's brand check recognizes promises across realms without consuming lazy thenables.
      if (this.isPromise(value)) Promise.prototype.then.call(value, close, close);
      else close();
      return value;
    } catch (error) {
      close();
      throw error;
    }
  }
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
