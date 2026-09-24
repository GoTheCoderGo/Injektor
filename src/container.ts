import { createAsyncLocalStorage } from "./async-local.ts";
import {
  INJECTABLE_KEY,
  CONSTRUCTOR_INJECT_KEY,
  PROPERTY_INJECT_KEY,
  NAMED_INJECT_KEY,
  TAGGED_INJECT_KEY,
  MULTI_INJECT_KEY,
  ACCESSOR_INJECT_KEY,
} from "./consts.ts";
import {
  ServiceNotFoundError,
  CircularDependencyError,
  NotInjectableError,
  AmbiguousBindingError,
  AsyncBindingError,
  InvalidBindingError,
} from "./errors.ts";
import { BindingBuilder } from "./binding.ts";
import { ContainerModule } from "./module.ts";
import type {
  Constructor,
  ServiceIdentifier,
  Binding,
  InjectArg,
  InjectDescriptor,
  ConstructorInjectMetadata,
  PropertyInjectMetadata,
  NamedInjectMetadata,
  TaggedInjectMetadata,
  MultiInjectMetadata,
  AccessorInjectMetadata,
  ContainerOptions,
} from "./types.ts";
import { Scope, BindingType } from "./types.ts";

// Polyfill Symbol.metadata for runtimes that don't yet expose it natively.
// @ts-ignore
Symbol.metadata ??= Symbol.for("Symbol.metadata");

type Constraints = {
  named?: string;
  tags?: Record<string, unknown>;
};

type RequestEntry = {
  settled: boolean;
  value?: unknown;
  promise?: Promise<unknown>;
};

type ResolutionContext = {
  requestCache: Map<Binding, RequestEntry>;
};

/** One binding activation. Reentering the same object is a cycle; a different binding for the same token is not. */
type Frame = {
  binding: Binding;
  parent?: Frame;
};

type Store = {
  container: Container;
  ctx: ResolutionContext;
  frame?: Frame;
  parentStore?: Store;
};

const resolutionStorage = createAsyncLocalStorage<Store>();
const startedEpoch = new WeakMap<Binding, number>();

function findStore(container: Container, store: Store | undefined): Store | undefined {
  for (let current = store; current; current = current.parentStore) {
    if (current.container === container) return current;
  }
  return undefined;
}

function frameHas(frame: Frame | undefined, binding: Binding): boolean {
  for (let current = frame; current; current = current.parent) {
    if (current.binding === binding) return true;
  }
  return false;
}

function cycleIds(frame: Frame | undefined, binding: Binding): ServiceIdentifier[] {
  const frames: Frame[] = [];
  for (let current = frame; current; current = current.parent) frames.push(current);
  const ids: ServiceIdentifier[] = [];
  for (let i = frames.length - 1; i >= 0; i--) ids.push(frames[i]!.binding.id);
  ids.push(binding.id);
  return ids;
}

function normalizeArg(arg: InjectArg): InjectDescriptor {
  if (
    typeof arg === "object" &&
    arg !== null &&
    !Array.isArray(arg) &&
    "token" in arg
  ) {
    return arg as InjectDescriptor;
  }
  return { token: arg as ServiceIdentifier };
}

function tagsMatch(binding: Binding, requiredTags: Record<string, unknown>): boolean {
  if (!binding.tags) return false;
  for (const [key, value] of Object.entries(requiredTags)) {
    if (binding.tags[key] !== value) return false;
  }
  return true;
}

/**
 * The IoC container. Manages bindings and resolves dependencies.
 *
 * Supports:
 * - Constructor and property injection via Stage 3 decorators
 * - Singleton, transient, and request scopes
 * - Named and tagged bindings
 * - Multi-injection (`getAll`, `getAllAsync`)
 * - Async factories (`getAsync`, `getNamedAsync`, `getTaggedAsync`, `getAllAsync`)
 * - Hierarchical (parent/child) containers
 * - Container modules (`load` / `unload`)
 *
 * @example
 * ```ts
 * const container = new Container();
 * container.bind(WEAPON_TOKEN).to(Katana).inSingletonScope();
 * container.bind(Warrior).toSelf();
 * const warrior = container.get(Warrior);
 * ```
 */
export class Container {
  /** Multi-binding storage: each token maps to an array of bindings. */
  private _bindings = new Map<ServiceIdentifier, Binding[]>();

  /** Tracks which bindings were added by each ContainerModule. */
  private _moduleBindings = new Map<ContainerModule, Binding[]>();

  /** Optional parent container for hierarchical resolution. */
  private _parent?: Container;

  /** Whether to automatically bind unregistered @injectable() classes. */
  private _autoBindInjectable: boolean;

  /** Sync resolution state. Async resolution uses {@link resolutionStorage} so concurrent gets stay isolated. */
  private _syncCtx?: ResolutionContext;
  private _syncFrame?: Frame;

  constructor(options?: ContainerOptions) {
    this._parent = options?.parent;
    this._autoBindInjectable = options?.autoBindInjectable ?? false;
  }

  /**
   * Start configuring a binding for the given service identifier.
   * Returns a fluent `BindingBuilder`.
   */
  bind<T>(id: ServiceIdentifier<T>): BindingBuilder<T> {
    return new BindingBuilder<T>(id, (binding) => {
      this._addBinding(binding as Binding);
    });
  }

  /**
   * Remove all bindings for the given service identifier.
   */
  unbind(id: ServiceIdentifier): void {
    this._bindings.delete(id);
  }

  /**
   * Remove all existing bindings for the identifier and return a new `BindingBuilder`.
   */
  rebind<T>(id: ServiceIdentifier<T>): BindingBuilder<T> {
    this.unbind(id);
    return this.bind(id);
  }

  /**
   * Check whether at least one binding exists for the given identifier.
   * Checks this container and its parent chain.
   */
  isBound(id: ServiceIdentifier): boolean {
    if (this._bindings.has(id) && this._bindings.get(id)!.length > 0) {
      return true;
    }
    return this._parent?.isBound(id) ?? false;
  }

  /**
   * Load a `ContainerModule`, executing its registry callback.
   * Bindings added by the module can later be removed with `unload()`.
   */
  load(module: ContainerModule): void {
    if (this._moduleBindings.has(module)) {
      throw new InvalidBindingError("Container module is already loaded.");
    }

    const registered: Binding[] = [];
    const bindFn = <T>(id: ServiceIdentifier<T>): BindingBuilder<T> => {
      return new BindingBuilder<T>(id, (binding) => {
        registered.push(binding as Binding);
        this._addBinding(binding as Binding);
      });
    };

    try {
      module.registry(bindFn);
    } catch (err) {
      for (const binding of registered) this._removeBinding(binding);
      throw err;
    }
    this._moduleBindings.set(module, registered);
  }

  /**
   * Unload a previously loaded `ContainerModule`, removing its bindings.
   */
  unload(module: ContainerModule): void {
    const bindings = this._moduleBindings.get(module);
    if (bindings) {
      for (const binding of bindings) {
        this._removeBinding(binding);
      }
      this._moduleBindings.delete(module);
    }
  }

  /**
   * Resolve a single dependency by its service identifier.
   *
   * @throws {ServiceNotFoundError} if no binding exists.
   * @throws {AmbiguousBindingError} if multiple bindings exist (use `getAll`, `getNamed`, or `getTagged`).
   * @throws {CircularDependencyError} if a cycle is detected.
   * @throws {NotInjectableError} if the target class lacks `@injectable()`.
   * @throws {AsyncBindingError} if the binding is an async factory.
   */
  get<T>(id: ServiceIdentifier<T>): T {
    const warm = this._warmSingleton(id);
    if (warm) return warm.cache as T;
    return this._runSync(() => this._resolve(id, {}));
  }

  /**
   * Resolve a dependency by service identifier + named constraint.
   */
  getNamed<T>(id: ServiceIdentifier<T>, name: string): T {
    return this._runSync(() => this._resolve(id, { named: name }));
  }

  /**
   * Resolve a dependency by service identifier + tagged constraint.
   */
  getTagged<T>(id: ServiceIdentifier<T>, key: string, value: unknown): T {
    return this._runSync(() => this._resolve(id, { tags: { [key]: value } }));
  }

  /**
   * Resolve ALL bindings for a service identifier.
   * Returns an array of resolved instances.
   */
  getAll<T>(id: ServiceIdentifier<T>): T[] {
    return this._runSync(() => this._resolveAll(id, {}));
  }

  /**
   * Asynchronously resolve a dependency. Required for `AsyncFactory` bindings.
   * Also works with sync bindings (returns an immediately-resolved promise).
   */
  async getAsync<T>(id: ServiceIdentifier<T>): Promise<T> {
    return this._runAsync(() => this._resolveAsync(id, {}));
  }

  /**
   * Asynchronously resolve a dependency by service identifier + named constraint.
   */
  async getNamedAsync<T>(id: ServiceIdentifier<T>, name: string): Promise<T> {
    return this._runAsync(() => this._resolveAsync(id, { named: name }));
  }

  /**
   * Asynchronously resolve a dependency by service identifier + tagged constraint.
   */
  async getTaggedAsync<T>(
    id: ServiceIdentifier<T>,
    key: string,
    value: unknown,
  ): Promise<T> {
    return this._runAsync(() =>
      this._resolveAsync(id, { tags: { [key]: value } }),
    );
  }

  /**
   * Asynchronously resolve ALL bindings for a service identifier.
   * Returns an array of resolved instances.
   */
  async getAllAsync<T>(id: ServiceIdentifier<T>): Promise<T[]> {
    return this._runAsync(() => this._resolveAllAsync(id, {}));
  }

  private _addBinding(binding: Binding): void {
    const list = this._bindings.get(binding.id);
    if (list) {
      list.push(binding);
    } else {
      this._bindings.set(binding.id, [binding]);
    }
  }

  private _removeBinding(binding: Binding): void {
    const list = this._bindings.get(binding.id);
    if (!list) return;
    const idx = list.indexOf(binding);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) this._bindings.delete(binding.id);
  }

  private _lookupAll(id: ServiceIdentifier): Binding[] {
    const local = this._bindings.get(id) ?? [];
    const parent = this._parent?._lookupAll(id) ?? [];
    return [...local, ...parent];
  }

  private _tryAutoBind(id: ServiceIdentifier): Binding | undefined {
    if (!this._autoBindInjectable || typeof id !== "function") return undefined;
    const metadata = (id as Constructor)[Symbol.metadata] as
      | Record<symbol, unknown>
      | undefined;
    if (!metadata || metadata[INJECTABLE_KEY] !== true) return undefined;
    const before = this._bindings.get(id)?.length ?? 0;
    this.bind(id as Constructor).toSelf();
    const list = this._bindings.get(id);
    if (!list || list.length <= before) return undefined;
    return list[list.length - 1];
  }

  private _filterBindings<T>(bindings: Binding<T>[], constraints: Constraints): Binding<T>[] {
    let candidates = bindings;
    if (constraints.named !== undefined) {
      candidates = candidates.filter((b) => b.name === constraints.named);
    }
    if (constraints.tags !== undefined) {
      const tags = constraints.tags;
      candidates = candidates.filter((b) => tagsMatch(b, tags));
    }
    return candidates;
  }

  /**
   * Unconstrained cached singleton on this container or an ancestor.
   * A local binding that is not a warm singleton stops the walk.
   * The binding object is the hit, so a stored `undefined` still counts.
   */
  private _warmSingleton<T>(id: ServiceIdentifier<T>): Binding<T> | undefined {
    let current: Container | undefined = this;
    while (current) {
      const local = current._bindings.get(id) as Binding<T>[] | undefined;
      if (local) {
        if (local.length !== 1) return undefined;
        const binding = local[0]!;
        if (binding.scope === Scope.Singleton && binding.cached) return binding;
        return undefined;
      }
      current = current._parent;
    }
    return undefined;
  }

  /**
   * Parent bindings win over autobind. An autobound class that does not
   * satisfy the constraint is removed so a failed named lookup cannot
   * stick an unnamed binding.
   */
  private _selectBinding<T>(id: ServiceIdentifier<T>, constraints: Constraints): Binding<T> {
    const local = (this._bindings.get(id) ?? []) as Binding<T>[];
    const localCandidates = this._filterBindings(local, constraints);

    if (localCandidates.length === 1) return localCandidates[0]!;
    if (localCandidates.length > 1) {
      throw new AmbiguousBindingError(id, localCandidates.length);
    }

    if (this._parent) {
      try {
        return this._parent._selectBinding(id, constraints);
      } catch (err) {
        if (!(err instanceof ServiceNotFoundError)) throw err;
      }
    }

    if (local.length === 0) {
      const created = this._tryAutoBind(id) as Binding<T> | undefined;
      if (created && this._filterBindings([created], constraints).length === 1) {
        return created;
      }
      if (created) this._removeBinding(created);
    }

    throw new ServiceNotFoundError(id);
  }

  private _owns(binding: Binding): boolean {
    return this._bindings.get(binding.id)?.includes(binding) ?? false;
  }

  private _owner(binding: Binding): Container {
    if (this._owns(binding)) return this;
    if (this._parent) return this._parent._owner(binding);
    return this;
  }

  /** Singletons are built by the container that registered them, so a child cannot publish its own instance into the shared binding. */
  private _isForeignSingleton(binding: Binding): boolean {
    return binding.scope === Scope.Singleton && !this._owns(binding);
  }

  private _runSync<T>(fn: () => T): T {
    if (findStore(this, resolutionStorage.getStore()) || this._syncCtx) return fn();
    this._syncCtx = { requestCache: new Map() };
    this._syncFrame = undefined;
    try {
      return fn();
    } finally {
      this._syncCtx = undefined;
      this._syncFrame = undefined;
    }
  }

  private _runAsync<T>(fn: () => Promise<T>): Promise<T> {
    const nested = resolutionStorage.inCall?.() ?? true;
    if (nested && findStore(this, resolutionStorage.getStore())) return fn();
    const parentStore = resolutionStorage.getStore();
    if (this._syncCtx) {
      const store: Store = {
        container: this,
        ctx: this._syncCtx,
        frame: this._syncFrame,
        parentStore,
      };
      return resolutionStorage.run(store, fn);
    }
    const ctx: ResolutionContext = { requestCache: new Map() };
    const store: Store = { container: this, ctx, frame: undefined, parentStore };
    return resolutionStorage.run(store, fn);
  }

  private _currentCtx(): ResolutionContext {
    const found = findStore(this, resolutionStorage.getStore());
    const ctx = found?.ctx ?? this._syncCtx;
    if (!ctx) {
      throw new Error("Injektor: resolution context is missing.");
    }
    return ctx;
  }

  /**
   * Browser fallback only. A same-turn caller is a concurrent dedupe and may
   * wait on the in-flight promise. A later turn, while this binding is still
   * the held frame, is the factory resuming and calling back in.
   */
  #throwIfBrowserReentry(binding: Binding): void {
    const current = resolutionStorage.epoch;
    const started = startedEpoch.get(binding);
    if (current === undefined || started === undefined || current === started) return;
    let store = resolutionStorage.getStore()?.parentStore;
    while (store) {
      if (store.container === this && frameHas(store.frame, binding)) {
        throw new CircularDependencyError(cycleIds(store.frame, binding));
      }
      store = store.parentStore;
    }
  }

  private _currentFrame(): Frame | undefined {
    const found = findStore(this, resolutionStorage.getStore());
    if (found) return found.frame;
    return this._syncFrame;
  }

  private _withFrame<T>(frame: Frame, fn: () => T): T {
    const current = resolutionStorage.getStore();
    const found = findStore(this, current);
    if (found) {
      const store: Store = {
        container: this,
        ctx: found.ctx,
        frame,
        parentStore: current,
      };
      return resolutionStorage.run(store, fn);
    }
    const prev = this._syncFrame;
    this._syncFrame = frame;
    try {
      return fn();
    } finally {
      this._syncFrame = prev;
    }
  }

  private _resolve<T>(id: ServiceIdentifier<T>, constraints: Constraints): T {
    const binding = this._selectBinding(id, constraints);
    if (this._isForeignSingleton(binding)) {
      const owner = this._owner(binding);
      return owner._runSync(() => owner._resolveBindingSync(binding, id));
    }
    return this._resolveBindingSync(binding, id);
  }

  private _resolveAsync<T>(
    id: ServiceIdentifier<T>,
    constraints: Constraints,
    caller: Frame | undefined = this._currentFrame(),
  ): Promise<T> {
    const binding = this._selectBinding(id, constraints);
    if (this._isForeignSingleton(binding)) {
      const owner = this._owner(binding);
      return owner._runAsync(() => owner._resolveBindingAsync(binding, id, owner._currentFrame()));
    }
    return this._resolveBindingAsync(binding, id, caller);
  }

  private _matchingBindings<T>(id: ServiceIdentifier<T>, constraints: Constraints): Binding<T>[] {
    let all = this._lookupAll(id) as Binding<T>[];
    if (all.length === 0) {
      const created = this._tryAutoBind(id) as Binding<T> | undefined;
      all = this._lookupAll(id) as Binding<T>[];
      const matched = this._filterBindings(all, constraints);
      if (matched.length === 0) {
        if (created) this._removeBinding(created);
        throw new ServiceNotFoundError(id);
      }
      return matched;
    }
    const matched = this._filterBindings(all, constraints);
    if (matched.length === 0) throw new ServiceNotFoundError(id);
    return matched;
  }

  private _resolveAll<T>(id: ServiceIdentifier<T>, constraints: Constraints): T[] {
    return this._matchingBindings(id, constraints).map((binding) => {
      if (this._isForeignSingleton(binding)) {
        const owner = this._owner(binding);
        return owner._runSync(() => owner._resolveBindingSync(binding, id));
      }
      return this._resolveBindingSync(binding, id);
    });
  }

  private async _resolveAllAsync<T>(
    id: ServiceIdentifier<T>,
    constraints: Constraints,
    caller: Frame | undefined = this._currentFrame(),
  ): Promise<T[]> {
    const bindings = this._matchingBindings(id, constraints);
    return Promise.all(
      bindings.map((binding) => {
        if (this._isForeignSingleton(binding)) {
          const owner = this._owner(binding);
          return owner._runAsync(() => owner._resolveBindingAsync(binding, id, owner._currentFrame()));
        }
        return this._resolveBindingAsync(binding, id, caller);
      }),
    );
  }

  private _resolveBindingSync<T>(binding: Binding<T>, id: ServiceIdentifier<T>): T {
    if (binding.type === BindingType.Constant) return binding.value as T;
    if (binding.scope === Scope.Singleton && binding.cached) {
      return binding.cache as T;
    }

    const ctx = this._currentCtx();

    const requestEntry =
      binding.scope === Scope.Request ? ctx.requestCache.get(binding) : undefined;
    if (requestEntry) {
      if (!requestEntry.settled) throw new AsyncBindingError(id);
      return requestEntry.value as T;
    }

    const caller = this._currentFrame();
    if (frameHas(caller, binding)) {
      throw new CircularDependencyError(cycleIds(caller, binding));
    }

    const frame: Frame = { binding, parent: caller };
    return this._withFrame(frame, () => {
      const instance = this._produceSync(binding, id);
      if (binding.scope === Scope.Singleton) {
        binding.cache = instance;
        binding.cached = true;
      } else if (binding.scope === Scope.Request) {
        ctx.requestCache.set(binding, { settled: true, value: instance });
      }
      return instance;
    });
  }

  private _resolveBindingAsync<T>(
    binding: Binding<T>,
    id: ServiceIdentifier<T>,
    caller: Frame | undefined = this._currentFrame(),
  ): Promise<T> {
    if (binding.type === BindingType.Constant) {
      return Promise.resolve(binding.value as T);
    }

    const ctx = this._currentCtx();
    if (binding.scope === Scope.Singleton && binding.cached) {
      return Promise.resolve(binding.cache as T);
    }

    // Reentry of the binding now being constructed is a cycle. A sibling
    // lookup passes the parent frame, so it may share the in-flight promise.
    if (frameHas(caller, binding)) {
      throw new CircularDependencyError(cycleIds(caller, binding));
    }

    if (binding.scope === Scope.Singleton && binding.pendingPromise) {
      this.#throwIfBrowserReentry(binding);
      return binding.pendingPromise as Promise<T>;
    }

    const requestEntry =
      binding.scope === Scope.Request ? ctx.requestCache.get(binding) : undefined;
    if (requestEntry) {
      if (requestEntry.settled) return Promise.resolve(requestEntry.value as T);
      this.#throwIfBrowserReentry(binding);
      return requestEntry.promise as Promise<T>;
    }

    const frame: Frame = { binding, parent: caller };
    const store: Store = {
      container: this,
      ctx,
      frame,
      parentStore: resolutionStorage.getStore(),
    };

    return resolutionStorage.run(store, async () => {
      if (binding.scope === Scope.Singleton) {
        return this._resolveSingletonAsync(binding, id);
      }
      if (binding.scope === Scope.Request) {
        return this._resolveRequestAsync(binding, id, ctx);
      }
      return this._produceAsync(binding, id);
    });
  }

  /**
   * Publish the promise before the first await. Concurrent callers share it;
   * a reentrant caller hits the frame check above and throws instead of awaiting itself.
   */
  private async _resolveSingletonAsync<T>(
    binding: Binding<T>,
    id: ServiceIdentifier<T>,
  ): Promise<T> {
    let settle!: (value: T) => void;
    let fail!: (err: unknown) => void;
    const pending = new Promise<T>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    // The caller awaits this method, not `pending`. Mark the rejection handled
    // when nobody else is waiting, without hiding it from concurrent callers.
    pending.catch(() => {});
    binding.pendingPromise = pending;
    if (resolutionStorage.epoch !== undefined) {
      startedEpoch.set(binding, resolutionStorage.epoch);
    }
    try {
      const instance = await this._produceAsync(binding, id);
      binding.cache = instance;
      binding.cached = true;
      settle(instance);
      return instance;
    } catch (err) {
      fail(err);
      throw err;
    } finally {
      binding.pendingPromise = undefined;
    }
  }

  /** Reserve the request entry before awaiting so concurrent deps in one graph share one instance. */
  private async _resolveRequestAsync<T>(
    binding: Binding<T>,
    id: ServiceIdentifier<T>,
    ctx: ResolutionContext,
  ): Promise<T> {
    let settle!: (value: T) => void;
    let fail!: (err: unknown) => void;
    const pending = new Promise<T>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    pending.catch(() => {});
    ctx.requestCache.set(binding, { settled: false, promise: pending });
    if (resolutionStorage.epoch !== undefined) {
      startedEpoch.set(binding, resolutionStorage.epoch);
    }
    try {
      const instance = await this._produceAsync(binding, id);
      ctx.requestCache.set(binding, { settled: true, value: instance });
      settle(instance);
      return instance;
    } catch (err) {
      fail(err);
      throw err;
    }
  }

  private _produceSync<T>(binding: Binding<T>, id: ServiceIdentifier<T>): T {
    if (binding.type === BindingType.Factory) return binding.factory!() as T;
    if (binding.type === BindingType.AsyncFactory) throw new AsyncBindingError(id);
    return this._createInstance(binding.implementationClass as Constructor<T>);
  }

  private async _produceAsync<T>(binding: Binding<T>, id: ServiceIdentifier<T>): Promise<T> {
    if (binding.type === BindingType.AsyncFactory) {
      return binding.asyncFactory!() as Promise<T>;
    }
    if (binding.type === BindingType.Factory) return binding.factory!() as T;
    return this._createInstanceAsync(binding.implementationClass as Constructor<T>);
  }

  private _createInstance<T>(ctor: Constructor<T>): T {
    const metadata = ctor[Symbol.metadata] as Record<symbol, unknown> | undefined;
    if (!metadata || metadata[INJECTABLE_KEY] !== true) {
      throw new NotInjectableError(ctor);
    }

    const ctorArgs = (metadata[CONSTRUCTOR_INJECT_KEY] as ConstructorInjectMetadata) ?? [];
    const args = ctorArgs.map((arg) => {
      const desc = normalizeArg(arg);
      if (desc.multi) {
        return this._resolveAll(desc.token, { named: desc.named, tags: desc.tags });
      }
      return this._resolve(desc.token, { named: desc.named, tags: desc.tags });
    });

    const instance = new ctor(...args);
    this._injectProperties(instance as object, ctor, metadata);
    return instance;
  }

  private async _createInstanceAsync<T>(ctor: Constructor<T>): Promise<T> {
    const metadata = ctor[Symbol.metadata] as Record<symbol, unknown> | undefined;
    if (!metadata || metadata[INJECTABLE_KEY] !== true) {
      throw new NotInjectableError(ctor);
    }

    const ctorArgs = (metadata[CONSTRUCTOR_INJECT_KEY] as ConstructorInjectMetadata) ?? [];
    const caller = this._currentFrame();
    const args = await Promise.all(
      ctorArgs.map((arg) => {
        const desc = normalizeArg(arg);
        if (desc.multi) {
          return this._resolveAllAsync(desc.token, {
            named: desc.named,
            tags: desc.tags,
          }, caller);
        }
        return this._resolveAsync(desc.token, { named: desc.named, tags: desc.tags }, caller);
      }),
    );

    const instance = new ctor(...args);
    await this._injectPropertiesAsync(instance as object, ctor, metadata);
    return instance;
  }

  private _injectProperties(
    instance: object,
    ctor: Constructor,
    metadata: Record<symbol, unknown>,
  ): void {
    const propMap =
      (metadata[PROPERTY_INJECT_KEY] as PropertyInjectMetadata) ?? new Map();
    const namedMap =
      (metadata[NAMED_INJECT_KEY] as NamedInjectMetadata) ?? new Map();
    const taggedMap =
      (metadata[TAGGED_INJECT_KEY] as TaggedInjectMetadata) ?? new Map();
    const multiMap =
      (metadata[MULTI_INJECT_KEY] as MultiInjectMetadata) ?? new Map();

    for (const [fieldName, token] of propMap) {
      const value = this._resolve(token, {
        named: namedMap.get(fieldName),
        tags: taggedMap.get(fieldName),
      });
      this._assign(instance, ctor, metadata, fieldName, value);
    }

    for (const [fieldName, token] of multiMap) {
      const value = this._resolveAll(token, {
        named: namedMap.get(fieldName),
        tags: taggedMap.get(fieldName),
      });
      this._assign(instance, ctor, metadata, fieldName, value);
    }
  }

  private async _injectPropertiesAsync(
    instance: object,
    ctor: Constructor,
    metadata: Record<symbol, unknown>,
  ): Promise<void> {
    const propMap =
      (metadata[PROPERTY_INJECT_KEY] as PropertyInjectMetadata) ?? new Map();
    const namedMap =
      (metadata[NAMED_INJECT_KEY] as NamedInjectMetadata) ?? new Map();
    const taggedMap =
      (metadata[TAGGED_INJECT_KEY] as TaggedInjectMetadata) ?? new Map();
    const multiMap =
      (metadata[MULTI_INJECT_KEY] as MultiInjectMetadata) ?? new Map();

    for (const [fieldName, token] of propMap) {
      const value = await this._resolveAsync(token, {
        named: namedMap.get(fieldName),
        tags: taggedMap.get(fieldName),
      });
      this._assign(instance, ctor, metadata, fieldName, value);
    }

    for (const [fieldName, token] of multiMap) {
      const values = await this._resolveAllAsync(token, {
        named: namedMap.get(fieldName),
        tags: taggedMap.get(fieldName),
      });
      this._assign(instance, ctor, metadata, fieldName, values);
    }
  }

  private _assign(
    instance: object,
    ctor: Constructor,
    metadata: Record<symbol, unknown>,
    fieldName: string | symbol,
    value: unknown,
  ): void {
    const accessors = metadata[ACCESSOR_INJECT_KEY] as AccessorInjectMetadata | undefined;
    const info = accessors?.get(fieldName);
    if (info) {
      info.set(info.static ? (info.home ?? ctor) : instance, value);
      return;
    }
    (instance as Record<string | symbol, unknown>)[fieldName] = value;
  }
}
