/**
 * Async context without an npm dependency.
 * Node and Bun use the built-in AsyncLocalStorage when it can be loaded
 * without a static import. Browsers keep the store until the callback
 * promise settles, because native await skips Promise.prototype.then.
 */
export interface AsyncLocalStorageLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): R;
  /** True while a `run` callback is still on the stack. Browser fallback only. */
  inCall?(): boolean;
  /**
   * Synchronous-turn counter for the browser fallback. It advances on the
   * next microtask, before an async factory resumes.
   */
  epoch?: number;
}

type BuiltinModule = {
  getBuiltinModule?: (id: string) => { AsyncLocalStorage?: new () => AsyncLocalStorageLike<unknown> };
};

export function createAsyncLocalStorage<T>(): AsyncLocalStorageLike<T> {
  const Native = loadNativeAsyncLocalStorage();
  if (Native) return new Native();
  return new PromiseAsyncLocalStorage<T>();
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

export class PromiseAsyncLocalStorage<T> implements AsyncLocalStorageLike<T> {
  #sync: T | undefined;
  #held: T | undefined;
  #depth = 0;
  #bumpScheduled = false;
  epoch = 0;

  inCall(): boolean {
    return this.#depth > 0;
  }

  getStore(): T | undefined {
    return this.#depth > 0 ? this.#sync : this.#held;
  }

  run<R>(store: T, callback: () => R): R {
    this.#scheduleEpochBump();
    const previousSync = this.#sync;
    const previousHeld = this.#held;
    this.#sync = store;
    this.#held = store;
    this.#depth++;
    let result: R;
    try {
      result = callback();
    } catch (err) {
      this.#depth--;
      this.#sync = previousSync;
      this.#held = previousHeld;
      throw err;
    }
    this.#depth--;
    this.#sync = previousSync;
    if (!isPromise(result)) {
      this.#held = previousHeld;
      return result;
    }
    return result.finally(() => {
      if (this.#held === store) this.#held = previousHeld;
    }) as R;
  }

  #scheduleEpochBump(): void {
    if (this.#bumpScheduled) return;
    this.#bumpScheduled = true;
    queueMicrotask(() => {
      this.#bumpScheduled = false;
      this.epoch++;
    });
  }
}

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Promise<unknown>).then === "function"
  );
}
