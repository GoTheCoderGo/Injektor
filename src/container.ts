import { createAsyncLocalStorage } from "./async-local.ts";
import {
  getInjectableMetadata,
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
  BindingIdentifier,
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
  ResolutionContext as FactoryResolutionContext,
} from "./types.ts";
import { Scope, BindingType } from "./types.ts";

// Polyfill Symbol.metadata for runtimes that don't yet expose it natively.
// @ts-ignore
Symbol.metadata ??= Symbol.for("Symbol.metadata");

type Constraints = {
  named?: string;
  tags?: Record<string, unknown>;
};

const unconstrained: Constraints = {};

/** A service may itself be a promise. Keep it intact until a public single lookup returns. */
type Resolved<T> = { value: T };

type RequestEntry = {
  settled: boolean;
  value?: unknown;
  promise?: Promise<Resolved<unknown>>;
  frame?: Frame;
};

type ResolutionContext = {
  requestCache?: Map<Binding, RequestEntry>;
  ownerContexts?: Map<Container, ResolutionContext>;
};

/** One binding activation. Reentering the same object is a cycle; a different binding for the same token is not. */
type Frame = {
  binding: Binding;
  parent?: Frame;
  waitingFor?: Map<Frame, number>;
  settled?: boolean;
};

/** Only bindings registered by a module need a back-reference for unbind and retarget. */
type RegisteredBinding = Binding & {
  moduleBindings?: RegisteredBinding[];
  moduleIndex?: number;
};

type Store = {
  container: Container;
  ctx: ResolutionContext;
  frame?: Frame;
  parentStore?: Store;
};

const resolutionStorage = createAsyncLocalStorage<Store>();
const pendingSingletons = new WeakMap<Binding, { frame: Frame; ready: Promise<Resolved<unknown>> }>();

function findStore(container: Container, store: Store | undefined): Store | undefined {
  for (let current = store; current; current = current.parentStore) {
    if (current.container === container) return current;
  }
  return undefined;
}

function frameHas(frame: Frame | undefined, binding: Binding): boolean {
  for (let current = frame; current; current = current.parent) {
    if (!current.settled && current.binding === binding) return true;
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

/** Follow actual waits as well as ancestry: parallel branches can wait on each other. */
function dependencyPath(from: Frame, to: Frame, seen = new Set<Frame>()): Frame[] | undefined {
  if (from.settled || seen.has(from)) return undefined;
  if (from === to) return [from];
  seen.add(from);
  for (const dependency of from.waitingFor?.keys() ?? []) {
    const path = dependencyPath(dependency, to, seen);
    if (path) return [from, ...path];
  }
  return undefined;
}

function addDependency(caller: Frame | undefined, target: Frame): () => void {
  if (!caller || caller.settled || target.settled) return () => {};
  if (caller === target || target.waitingFor?.size) {
    const path = dependencyPath(target, caller);
    if (path) throw new CircularDependencyError([caller, ...path].map(frame => frame.binding.id));
  }
  const dependencies = caller.waitingFor ??= new Map();
  dependencies.set(target, (dependencies.get(target) ?? 0) + 1);
  return () => {
    const remaining = (dependencies.get(target) ?? 1) - 1;
    if (remaining > 0) dependencies.set(target, remaining);
    else dependencies.delete(target);
  };
}

function waitFor<T>(caller: Frame | undefined, target: Frame, promise: Promise<T>): Promise<T> {
  const release = addDependency(caller, target);
  return promise.then(
    (value) => { release(); return value; },
    (err) => { release(); throw err; },
  );
}

function hasInjectedProperties(metadata: Record<symbol, unknown>): boolean {
  return !!((metadata[PROPERTY_INJECT_KEY] as PropertyInjectMetadata | undefined)?.size ||
    (metadata[MULTI_INJECT_KEY] as MultiInjectMetadata | undefined)?.size);
}

function isDescriptor(arg: InjectArg): arg is InjectDescriptor {
  return typeof arg === "object" && arg !== null && !Array.isArray(arg) && "token" in arg;
}

function tagsMatch(binding: Binding, requiredTags: Record<string, unknown>): boolean {
  if (!binding.tags) return false;
  for (const [key, value] of Object.entries(requiredTags)) {
    if (!Object.hasOwn(binding.tags, key) || binding.tags[key] !== value) return false;
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
  private _bindings = new Map<ServiceIdentifier, RegisteredBinding[]>();

  /** Live registrations owned by each loaded module. */
  private _moduleBindings?: Map<ContainerModule, RegisteredBinding[]>;

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
  bind<T>(id: BindingIdentifier<T>): BindingBuilder<T> {
    return new BindingBuilder<T>(
      id,
      (binding) => this._addBinding(binding),
      (previous, next) => this._replaceBinding(previous, next),
    );
  }

  /**
   * Remove all bindings for the given service identifier.
   */
  unbind(id: ServiceIdentifier): void {
    if (this._moduleBindings) {
      for (const binding of this._bindings.get(id) ?? []) {
        const registered = binding.moduleBindings;
        if (!registered) continue;
        // Unload order is private. Fill the vacated slot in constant time.
        const last = registered.pop()!;
        if (last !== binding) {
          last.moduleIndex = binding.moduleIndex;
          registered[last.moduleIndex!] = last;
        }
        binding.moduleBindings = undefined;
      }
    }
    this._bindings.delete(id);
  }

  /**
   * Remove all existing bindings for the identifier and return a new `BindingBuilder`.
   */
  rebind<T>(id: BindingIdentifier<T>): BindingBuilder<T> {
    this.unbind(id);
    return this.bind(id);
  }

  /**
   * Check whether at least one binding exists for the given identifier.
   * Checks this container and its parent chain.
   */
  isBound(id: ServiceIdentifier): boolean {
    if (this._bindings.has(id)) {
      return true;
    }
    return this._parent?.isBound(id) ?? false;
  }

  /**
   * Load a `ContainerModule`, executing its registry callback.
   * Bindings added by the module can later be removed with `unload()`.
   */
  load(module: ContainerModule): void {
    const loaded = this._moduleBindings ??= new Map();
    if (loaded.has(module)) {
      throw new InvalidBindingError("Container module is already loaded.");
    }

    const registered: RegisteredBinding[] = [];
    loaded.set(module, registered);
    let open = true;
    const assertRegistering = () => {
      if (!open || loaded.get(module) !== registered) {
        throw new InvalidBindingError("Container module registration is closed.");
      }
    };
    const bindFn = <T>(id: BindingIdentifier<T>): BindingBuilder<T> => {
      assertRegistering();
      return new BindingBuilder<T>(id, (binding) => {
        assertRegistering();
        const entry: RegisteredBinding = binding;
        entry.moduleBindings = registered;
        entry.moduleIndex = registered.length;
        registered.push(entry);
        this._addBinding(entry);
      }, (previous, next) => this._replaceBinding(previous, next));
    };

    try {
      const result: unknown = module.registry(bindFn);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        // Observe the continuation, including attempts to use the closed registry.
        Promise.resolve(result).catch(() => {});
        throw new InvalidBindingError("Container module registries must be synchronous.");
      }
    } catch (err) {
      if (loaded.get(module) === registered) this.unload(module);
      throw err;
    } finally {
      open = false;
    }
  }

  /**
   * Unload a previously loaded `ContainerModule`, removing its bindings.
   */
  unload(module: ContainerModule): void {
    const loaded = this._moduleBindings;
    if (!loaded) return;
    const bindings = loaded.get(module);
    if (!bindings) return;
    for (const binding of bindings) {
      this._removeBinding(binding);
      binding.moduleBindings = undefined;
    }
    bindings.length = 0;
    loaded.delete(module);
    if (loaded.size === 0) this._moduleBindings = undefined;
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
    return this._runSync(() => this._resolve(id, unconstrained));
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
    return this._runSync(() => this._resolveAll(id, unconstrained));
  }

  /**
   * Asynchronously resolve a dependency. Required for `AsyncFactory` bindings.
   * Also works with sync bindings (returns an immediately-resolved promise).
   */
  async getAsync<T>(id: ServiceIdentifier<T>): Promise<Awaited<T>> {
    const warm = this._warmSingleton(id);
    if (warm) return await (warm.cache as T);
    const result = await this._runAsync(() => this._resolveAsync(id, unconstrained));
    return await result.value;
  }

  /**
   * Asynchronously resolve a dependency by service identifier + named constraint.
   */
  async getNamedAsync<T>(id: ServiceIdentifier<T>, name: string): Promise<Awaited<T>> {
    const result = await this._runAsync(() => this._resolveAsync(id, { named: name }));
    return await result.value;
  }

  /**
   * Asynchronously resolve a dependency by service identifier + tagged constraint.
   */
  async getTaggedAsync<T>(
    id: ServiceIdentifier<T>,
    key: string,
    value: unknown,
  ): Promise<Awaited<T>> {
    const result = await this._runAsync(() => this._resolveAsync(id, { tags: { [key]: value } }));
    return await result.value;
  }

  /**
   * Asynchronously resolve ALL bindings for a service identifier.
   * Returns an array of resolved instances.
   */
  async getAllAsync<T>(id: ServiceIdentifier<T>): Promise<T[]> {
    return this._runAsync(() => this._resolveAllAsync(id, unconstrained));
  }

  private _addBinding(binding: Binding): void {
    const list = this._bindings.get(binding.id);
    if (list) {
      list.push(binding);
    } else {
      this._bindings.set(binding.id, [binding]);
    }
  }

  private _replaceBinding(previous: RegisteredBinding, next: RegisteredBinding): void {
    const list = this._bindings.get(previous.id);
    if (!list) return;
    const index = list.indexOf(previous);
    if (index === -1) return;
    list[index] = next;
    const registered = previous.moduleBindings;
    if (registered) {
      next.moduleIndex = previous.moduleIndex;
      next.moduleBindings = registered;
      registered[next.moduleIndex!] = next;
      previous.moduleBindings = undefined;
    }
  }

  private _removeBinding(binding: Binding): void {
    const list = this._bindings.get(binding.id);
    if (!list) return;
    if (list.length === 1) {
      if (list[0] === binding) this._bindings.delete(binding.id);
      return;
    }
    const idx = list.indexOf(binding);
    if (idx !== -1) list.splice(idx, 1);
  }

  private _lookupAll(id: ServiceIdentifier): Binding[] {
    const local = this._bindings.get(id) ?? [];
    const parent = this._parent?._lookupAll(id) ?? [];
    return [...local, ...parent];
  }

  private _tryAutoBind(id: ServiceIdentifier): Binding | undefined {
    if (!this._autoBindInjectable || typeof id !== "function") return undefined;
    if (!getInjectableMetadata(id)) return undefined;
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
    return this._parent !== undefined && binding.scope === Scope.Singleton && !this._owns(binding);
  }

  /** Delegate lookup to the owner, retaining its request cache for this graph. */
  private _withOwner<T>(binding: Binding, resolve: (owner: Container) => T): T {
    const owner = this._owner(binding);
    const parentStore = this._captureStore();
    const contexts = parentStore.ctx.ownerContexts ??= new Map();
    let ctx = findStore(owner, parentStore)?.ctx ?? owner._syncCtx ?? contexts.get(owner);
    if (!ctx) {
      ctx = { ownerContexts: contexts };
      contexts.set(owner, ctx);
    }
    const store = { container: owner, ctx, frame: parentStore.frame, parentStore };
    return resolutionStorage.run(store, () => resolve(owner));
  }

  private _runSync<T>(fn: () => T): T {
    if (findStore(this, resolutionStorage.getStore()) || this._syncCtx) return fn();
    this._syncCtx = {};
    this._syncFrame = undefined;
    try {
      return fn();
    } finally {
      this._syncCtx = undefined;
      this._syncFrame = undefined;
    }
  }

  private _runAsync<T>(fn: () => Promise<T>): Promise<T> {
    if (findStore(this, resolutionStorage.getStore())) return fn();
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
    const ctx: ResolutionContext = {};
    const store: Store = { container: this, ctx, frame: parentStore?.frame, parentStore };
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

  private _currentFrame(): Frame | undefined {
    const current = resolutionStorage.getStore();
    // Binding ancestry spans containers even when their request caches differ.
    if (findStore(this, current)) return current?.frame;
    return this._syncFrame ?? current?.frame;
  }

  private _captureStore(): Store {
    const current = resolutionStorage.getStore();
    if (current?.container === this) return current;
    return {
      container: this,
      ctx: this._currentCtx(),
      frame: this._currentFrame(),
      parentStore: current,
    };
  }

  /** Bind factory lookups to their graph without relying on ambient browser state. */
  private _factoryContext(): FactoryResolutionContext {
    const store = this._captureStore();
    const run = <T>(fn: () => T): T => resolutionStorage.run(store, fn);
    return {
      get: (id) => run(() => this.get(id)),
      getNamed: (id, name) => run(() => this.getNamed(id, name)),
      getTagged: (id, key, value) => run(() => this.getTagged(id, key, value)),
      getAll: (id) => run(() => this.getAll(id)),
      getAsync: (id) => run(() => this.getAsync(id)),
      getNamedAsync: (id, name) => run(() => this.getNamedAsync(id, name)),
      getTaggedAsync: (id, key, value) => run(() => this.getTaggedAsync(id, key, value)),
      getAllAsync: (id) => run(() => this.getAllAsync(id)),
    };
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
      return this._withOwner(binding, (owner) => owner._resolveBindingSync(binding, id));
    }
    return this._resolveBindingSync(binding, id);
  }

  private _resolveAsync<T>(
    id: ServiceIdentifier<T>,
    constraints: Constraints,
    caller: Frame | undefined = this._currentFrame(),
  ): Promise<Resolved<T>> {
    const binding = this._selectBinding(id, constraints);
    if (this._isForeignSingleton(binding)) {
      return this._withOwner(binding, (owner) => owner._resolveBindingAsync(binding, id, caller));
    }
    return this._resolveBindingAsync(binding, id, caller);
  }

  private _matchingBindings<T>(id: ServiceIdentifier<T>, constraints: Constraints): Binding<T>[] {
    const all = this._lookupAll(id) as Binding<T>[];
    if (all.length === 0) return [this._selectBinding(id, constraints)];
    const matched = this._filterBindings(all, constraints);
    if (matched.length === 0) throw new ServiceNotFoundError(id);
    return matched;
  }

  private _resolveAll<T>(id: ServiceIdentifier<T>, constraints: Constraints): T[] {
    return this._matchingBindings(id, constraints).map((binding) => {
      if (this._isForeignSingleton(binding)) {
        return this._withOwner(binding, (owner) => owner._resolveBindingSync(binding, id));
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
    const results = await Promise.all(
      bindings.map(async (binding) => {
        if (this._isForeignSingleton(binding)) {
          return this._withOwner(binding, (owner) => owner._resolveBindingAsync(binding, id, caller));
        }
        return this._resolveBindingAsync(binding, id, caller);
      }),
    );
    return results.map(result => result.value);
  }

  private _resolveBindingSync<T>(binding: Binding<T>, id: ServiceIdentifier<T>): T {
    if (binding.type === BindingType.Constant) return binding.value as T;
    if (binding.scope === Scope.Singleton && binding.cached) {
      return binding.cache as T;
    }

    const caller = this._currentFrame();
    if (frameHas(caller, binding)) {
      throw new CircularDependencyError(cycleIds(caller, binding));
    }
    if (binding.scope === Scope.Singleton && binding.pendingPromise) {
      throw new AsyncBindingError(id);
    }
    const requestEntry =
      binding.scope === Scope.Request ? this._currentCtx().requestCache?.get(binding) : undefined;
    if (requestEntry) {
      if (!requestEntry.settled) throw new AsyncBindingError(id);
      return requestEntry.value as T;
    }

    const frame: Frame = { binding, parent: caller };
    try {
      return this._withFrame(frame, () => {
        const instance = this._produceSync(binding, id);
        if (binding.scope === Scope.Singleton) {
          binding.cache = instance;
          binding.cached = true;
        } else if (binding.scope === Scope.Request) {
          const cache = this._currentCtx().requestCache ??= new Map();
          cache.set(binding, { settled: true, value: instance });
        }
        return instance;
      });
    } finally {
      frame.settled = true;
    }
  }

  private _resolveBindingAsync<T>(
    binding: Binding<T>,
    id: ServiceIdentifier<T>,
    caller: Frame | undefined = this._currentFrame(),
  ): Promise<Resolved<T>> {
    if (binding.type === BindingType.Constant) {
      return Promise.resolve({ value: binding.value as T });
    }

    const ctx = this._currentCtx();
    if (binding.scope === Scope.Singleton && binding.cached) {
      return Promise.resolve({ value: binding.cache as T });
    }

    // Reentry of the binding now being constructed is a cycle. A sibling
    // lookup passes the parent frame, so it may share the in-flight promise.
    if (frameHas(caller, binding)) {
      throw new CircularDependencyError(cycleIds(caller, binding));
    }

    if (binding.scope === Scope.Singleton && binding.pendingPromise) {
      const pending = pendingSingletons.get(binding)!;
      return waitFor(caller, pending.frame, pending.ready as Promise<Resolved<T>>);
    }

    const requestEntry =
      binding.scope === Scope.Request ? ctx.requestCache?.get(binding) : undefined;
    if (requestEntry) {
      if (requestEntry.settled) return Promise.resolve({ value: requestEntry.value as T });
      return waitFor(caller, requestEntry.frame!, requestEntry.promise as Promise<Resolved<T>>);
    }

    const frame: Frame = { binding, parent: caller };
    const release = addDependency(caller, frame);
    const store: Store = {
      container: this,
      ctx,
      frame,
      parentStore: resolutionStorage.getStore(),
    };

    const promise = resolutionStorage.run(store, () => {
      if (binding.scope === Scope.Singleton) {
        return this._resolveSingletonAsync(binding, frame);
      }
      if (binding.scope === Scope.Request) {
        return this._resolveRequestAsync(binding, ctx, frame);
      }
      return this._produceAsync(binding);
    });
    const finish = () => {
      frame.settled = true;
      frame.waitingFor?.clear();
      release();
    };
    return promise.then(
      (value) => { finish(); return value; },
      (err) => { finish(); throw err; },
    );
  }

  /**
   * Publish the promise before the first await. Concurrent callers share it;
   * a reentrant caller hits the frame check above and throws instead of awaiting itself.
   */
  private async _resolveSingletonAsync<T>(
    binding: Binding<T>,
    frame: Frame,
  ): Promise<Resolved<T>> {
    let settle!: (result: Resolved<T>) => void;
    let fail!: (err: unknown) => void;
    const pending = new Promise<Resolved<T>>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    // The caller awaits this method, not `pending`. Mark the rejection handled
    // when nobody else is waiting, without hiding it from concurrent callers.
    binding.pendingPromise = pending.then(result => result.value);
    binding.pendingPromise.catch(() => {});
    pendingSingletons.set(binding, { frame, ready: pending });
    try {
      const result = await this._produceAsync(binding);
      binding.cache = result.value;
      binding.cached = true;
      settle(result);
      return result;
    } catch (err) {
      fail(err);
      throw err;
    } finally {
      binding.pendingPromise = undefined;
      pendingSingletons.delete(binding);
    }
  }

  /** Reserve the request entry before awaiting so concurrent deps in one graph share one instance. */
  private async _resolveRequestAsync<T>(
    binding: Binding<T>,
    ctx: ResolutionContext,
    frame: Frame,
  ): Promise<Resolved<T>> {
    let settle!: (result: Resolved<T>) => void;
    let fail!: (err: unknown) => void;
    const pending = new Promise<Resolved<T>>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    pending.catch(() => {});
    const cache = ctx.requestCache ??= new Map();
    cache.set(binding, { settled: false, promise: pending, frame });
    try {
      const result = await this._produceAsync(binding);
      cache.set(binding, { settled: true, value: result.value });
      settle(result);
      return result;
    } catch (err) {
      cache.delete(binding);
      fail(err);
      throw err;
    }
  }

  private _produceSync<T>(binding: Binding<T>, id: ServiceIdentifier<T>): T {
    if (binding.type === BindingType.Factory) return binding.factory!(this._factoryContext());
    if (binding.type === BindingType.AsyncFactory) throw new AsyncBindingError(id);
    return this._createInstance(binding.implementationClass as Constructor<T>);
  }

  private async _produceAsync<T>(binding: Binding<T>): Promise<Resolved<T>> {
    if (binding.type === BindingType.AsyncFactory) {
      return { value: await binding.asyncFactory!(this._factoryContext()) };
    }
    if (binding.type === BindingType.Factory) return { value: binding.factory!(this._factoryContext()) };
    return this._createInstanceAsync(binding.implementationClass as Constructor<T>);
  }

  private _createInstance<T>(ctor: Constructor<T>): T {
    const metadata = getInjectableMetadata(ctor);
    if (!metadata) {
      throw new NotInjectableError(ctor);
    }

    const ctorArgs = metadata[CONSTRUCTOR_INJECT_KEY] as ConstructorInjectMetadata | undefined;
    let instance: T;
    if (ctorArgs?.length) {
      const args = ctorArgs.map(arg => {
        if (!isDescriptor(arg)) return this._resolve(arg, unconstrained);
        const { multi, token, named, tags } = arg;
        return multi ? this._resolveAll(token, { named, tags }) : this._resolve(token, { named, tags });
      });
      instance = new ctor(...args);
    } else {
      instance = new ctor();
    }
    if (hasInjectedProperties(metadata)) this._injectProperties(instance as object, ctor, metadata);
    return instance;
  }

  private async _createInstanceAsync<T>(ctor: Constructor<T>): Promise<Resolved<T>> {
    const store = this._captureStore();
    const metadata = getInjectableMetadata(ctor);
    if (!metadata) {
      throw new NotInjectableError(ctor);
    }

    const ctorArgs = metadata[CONSTRUCTOR_INJECT_KEY] as ConstructorInjectMetadata | undefined;
    let instance: T;
    if (ctorArgs?.length) {
      const caller = store.frame;
      const dependencies = await Promise.all(ctorArgs.map(async arg => {
        if (!isDescriptor(arg)) return this._resolveAsync(arg, unconstrained, caller);
        const { multi, token, named, tags } = arg;
        if (multi) return { value: await this._resolveAllAsync(token, { named, tags }, caller) };
        return this._resolveAsync(token, { named, tags }, caller);
      }));
      const args = dependencies.map(result => result.value);
      instance = resolutionStorage.run(store, () => new ctor(...args));
    } else {
      // Keep getAsync construction deferred, including in runtimes without native async context.
      await Promise.resolve();
      instance = resolutionStorage.run(store, () => new ctor());
    }
    if (hasInjectedProperties(metadata)) {
      await this._injectPropertiesAsync(instance as object, ctor, metadata, store);
    }
    return { value: instance };
  }

  private _injectProperties(
    instance: object,
    ctor: Constructor,
    metadata: Record<symbol, unknown>,
  ): void {
    const propMap =
      metadata[PROPERTY_INJECT_KEY] as PropertyInjectMetadata | undefined;
    const namedMap =
      metadata[NAMED_INJECT_KEY] as NamedInjectMetadata | undefined;
    const taggedMap =
      metadata[TAGGED_INJECT_KEY] as TaggedInjectMetadata | undefined;
    const multiMap =
      metadata[MULTI_INJECT_KEY] as MultiInjectMetadata | undefined;

    for (const [fieldName, token] of propMap ?? []) {
      const value = this._resolve(token, {
        named: namedMap?.get(fieldName),
        tags: taggedMap?.get(fieldName),
      });
      this._assign(instance, ctor, metadata, fieldName, value);
    }

    for (const [fieldName, token] of multiMap ?? []) {
      const value = this._resolveAll(token, {
        named: namedMap?.get(fieldName),
        tags: taggedMap?.get(fieldName),
      });
      this._assign(instance, ctor, metadata, fieldName, value);
    }
  }

  private async _injectPropertiesAsync(
    instance: object,
    ctor: Constructor,
    metadata: Record<symbol, unknown>,
    store: Store,
  ): Promise<void> {
    const propMap =
      metadata[PROPERTY_INJECT_KEY] as PropertyInjectMetadata | undefined;
    const namedMap =
      metadata[NAMED_INJECT_KEY] as NamedInjectMetadata | undefined;
    const taggedMap =
      metadata[TAGGED_INJECT_KEY] as TaggedInjectMetadata | undefined;
    const multiMap =
      metadata[MULTI_INJECT_KEY] as MultiInjectMetadata | undefined;

    for (const [fieldName, token] of propMap ?? []) {
      const { value } = await resolutionStorage.run(store, () => this._resolveAsync(token, {
        named: namedMap?.get(fieldName),
        tags: taggedMap?.get(fieldName),
      }));
      resolutionStorage.run(store, () => this._assign(instance, ctor, metadata, fieldName, value));
    }

    for (const [fieldName, token] of multiMap ?? []) {
      const values = await resolutionStorage.run(store, () => this._resolveAllAsync(token, {
        named: namedMap?.get(fieldName),
        tags: taggedMap?.get(fieldName),
      }));
      resolutionStorage.run(store, () => this._assign(instance, ctor, metadata, fieldName, values));
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
