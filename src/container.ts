import { createFactoryStorage } from "./async-local.ts";
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
};

/** One binding activation. Reentering the same object is a cycle; a different binding for the same token is not. */
type Frame = {
  binding: Binding;
  parent?: Frame;
  async?: boolean;
  waitingFor?: Map<Frame, number>;
  settled?: boolean;
};

/** Keep the registering container even if an in-flight selection outlives registration. */
type RegisteredBinding<T = unknown> = Binding<T> & {
  owner: Container;
  moduleBindings?: RegisteredBinding[];
  moduleIndex?: number;
};

type Store = {
  ctx: ResolutionContext;
  frame?: Frame;
};

const factoryStorage = createFactoryStorage<Store>();

// The synchronous stack also works in browsers. Only user factories need a native
// async store; internal continuations explicitly reenter the graph they captured.
let syncStore: Store | undefined;

function currentStore(): Store | undefined {
  return syncStore ?? factoryStorage.getStore();
}

function enterStore<T>(store: Store, fn: () => T): T {
  const previous = syncStore;
  syncStore = store;
  try {
    return fn();
  } finally {
    syncStore = previous;
  }
}

function inGraph<T>(fn: () => T): T {
  return currentStore() ? fn() : enterStore({ ctx: {} }, fn);
}

function activeFrame(frame: Frame | undefined): Frame | undefined {
  while (frame?.settled) frame = frame.parent;
  return frame;
}

const pendingSingletons = new WeakMap<Binding, { frame: Frame; ready: Promise<Resolved<unknown>> }>();

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

/** Parallel branches can form a cycle through outstanding waits. */
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
  // A sync factory can return a provider or a promise started during construction.
  // Attribute async waits to the enclosing activation that can actually wait.
  while (caller && (!caller.async || caller.settled)) caller = caller.parent;
  if (!caller || target.settled) return () => {};
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
        const entry = this._addBinding(binding);
        entry.moduleBindings = registered;
        entry.moduleIndex = registered.length;
        registered.push(entry);
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
    return inGraph(() => this._resolve(id, unconstrained));
  }

  /**
   * Resolve a dependency by service identifier + named constraint.
   */
  getNamed<T>(id: ServiceIdentifier<T>, name: string): T {
    return inGraph(() => this._resolve(id, { named: name }));
  }

  /**
   * Resolve a dependency by service identifier + tagged constraint.
   */
  getTagged<T>(id: ServiceIdentifier<T>, key: string, value: unknown): T {
    return inGraph(() => this._resolve(id, { tags: { [key]: value } }));
  }

  /**
   * Resolve ALL bindings for a service identifier.
   * Returns an array of resolved instances.
   */
  getAll<T>(id: ServiceIdentifier<T>): T[] {
    return inGraph(() => this._resolveAll(id, unconstrained));
  }

  /**
   * Asynchronously resolve a dependency. Required for `AsyncFactory` bindings.
   * Also works with sync bindings (returns an immediately-resolved promise).
   */
  async getAsync<T>(id: ServiceIdentifier<T>): Promise<Awaited<T>> {
    const warm = this._warmSingleton(id);
    if (warm) return await (warm.cache as T);
    const result = await inGraph(() => this._resolveAsync(id, unconstrained));
    return await result.value;
  }

  /**
   * Asynchronously resolve a dependency by service identifier + named constraint.
   */
  async getNamedAsync<T>(id: ServiceIdentifier<T>, name: string): Promise<Awaited<T>> {
    const result = await inGraph(() => this._resolveAsync(id, { named: name }));
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
    const result = await inGraph(() => this._resolveAsync(id, { tags: { [key]: value } }));
    return await result.value;
  }

  /**
   * Asynchronously resolve ALL bindings for a service identifier.
   * Returns an array of resolved instances.
   */
  async getAllAsync<T>(id: ServiceIdentifier<T>): Promise<T[]> {
    return inGraph(() => this._resolveAllAsync(id, unconstrained));
  }

  private _addBinding(binding: Binding): RegisteredBinding {
    const entry = Object.assign(binding, { owner: this });
    const list = this._bindings.get(binding.id);
    if (list) {
      list.push(entry);
    } else {
      this._bindings.set(binding.id, [entry]);
    }
    return entry;
  }

  private _replaceBinding(previous: Binding, next: Binding): void {
    const list = this._bindings.get(previous.id);
    if (!list) return;
    // Fluent scope configuration usually replaces the binding just appended.
    const last = list.length - 1;
    const index = list[last] === previous ? last : list.findIndex(entry => entry === previous);
    if (index === -1) return;
    const old = list[index]!;
    const entry: RegisteredBinding = Object.assign(next, { owner: this });
    list[index] = entry;
    const registered = old.moduleBindings;
    if (registered) {
      entry.moduleIndex = old.moduleIndex;
      entry.moduleBindings = registered;
      registered[entry.moduleIndex!] = entry;
      old.moduleBindings = undefined;
    }
  }

  private _removeBinding(binding: RegisteredBinding): void {
    const list = this._bindings.get(binding.id);
    if (!list) return;
    if (list.length === 1) {
      if (list[0] === binding) this._bindings.delete(binding.id);
      return;
    }
    const idx = list.indexOf(binding);
    if (idx !== -1) list.splice(idx, 1);
  }

  private _lookupAll(id: ServiceIdentifier): RegisteredBinding[] {
    const local = this._bindings.get(id) ?? [];
    const parent = this._parent?._lookupAll(id) ?? [];
    return [...local, ...parent];
  }

  private _tryAutoBind(id: ServiceIdentifier): RegisteredBinding | undefined {
    if (!this._autoBindInjectable || typeof id !== "function") return undefined;
    if (!getInjectableMetadata(id)) return undefined;
    const before = this._bindings.get(id)?.length ?? 0;
    this.bind(id as Constructor).toSelf();
    const list = this._bindings.get(id);
    if (!list || list.length <= before) return undefined;
    return list[list.length - 1];
  }

  private _filterBindings<T>(bindings: RegisteredBinding<T>[], constraints: Constraints): RegisteredBinding<T>[] {
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
  private _selectBinding<T>(id: ServiceIdentifier<T>, constraints: Constraints): RegisteredBinding<T> {
    const local = (this._bindings.get(id) ?? []) as RegisteredBinding<T>[];
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
      const created = this._tryAutoBind(id) as RegisteredBinding<T> | undefined;
      if (created && this._filterBindings([created], constraints).length === 1) {
        return created;
      }
      if (created) this._removeBinding(created);
    }

    throw new ServiceNotFoundError(id);
  }

  /** Shared instances use a stable dependency environment throughout the graph. */
  private _resolutionOwner(binding: RegisteredBinding): Container {
    return binding.scope === Scope.Transient ? this : binding.owner;
  }

  /** Bind factory lookups to their graph without relying on ambient browser state. */
  private _factoryContext(store: Store): FactoryResolutionContext {
    const run = <T>(fn: () => T): T => {
      if (!store.frame?.settled) return enterStore(store, fn);
      // A returned provider may now be called by a different activation.
      const frame = activeFrame(currentStore()?.frame) ?? activeFrame(store.frame);
      return enterStore({ ctx: store.ctx, frame }, fn);
    };
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

  private _resolve<T>(id: ServiceIdentifier<T>, constraints: Constraints): T {
    const binding = this._selectBinding(id, constraints);
    return this._resolutionOwner(binding)._resolveBindingSync(binding, id);
  }

  private _resolveAsync<T>(
    id: ServiceIdentifier<T>,
    constraints: Constraints,
    caller: Frame | undefined = activeFrame(currentStore()?.frame),
  ): Promise<Resolved<T>> {
    const binding = this._selectBinding(id, constraints);
    return this._resolutionOwner(binding)._resolveBindingAsync(binding, id, caller);
  }

  private _matchingBindings<T>(id: ServiceIdentifier<T>, constraints: Constraints): RegisteredBinding<T>[] {
    const all = this._lookupAll(id) as RegisteredBinding<T>[];
    if (all.length === 0) return [this._selectBinding(id, constraints)];
    const matched = this._filterBindings(all, constraints);
    if (matched.length === 0) throw new ServiceNotFoundError(id);
    return matched;
  }

  private _resolveAll<T>(id: ServiceIdentifier<T>, constraints: Constraints): T[] {
    return this._matchingBindings(id, constraints).map(binding =>
      this._resolutionOwner(binding)._resolveBindingSync(binding, id));
  }

  private async _resolveAllAsync<T>(
    id: ServiceIdentifier<T>,
    constraints: Constraints,
    caller: Frame | undefined = activeFrame(currentStore()?.frame),
  ): Promise<T[]> {
    const bindings = this._matchingBindings(id, constraints);
    const results = await Promise.all(
      bindings.map(async binding => this._resolutionOwner(binding)._resolveBindingAsync(binding, id, caller)),
    );
    return results.map(result => result.value);
  }

  private _resolveBindingSync<T>(binding: Binding<T>, id: ServiceIdentifier<T>): T {
    if (binding.type === BindingType.Constant) return binding.value as T;
    if (binding.scope === Scope.Singleton && binding.cached) {
      return binding.cache as T;
    }

    const { ctx, frame: parent } = currentStore()!;
    const caller = activeFrame(parent);
    if (frameHas(caller, binding)) {
      throw new CircularDependencyError(cycleIds(caller, binding));
    }
    if (binding.scope === Scope.Singleton && pendingSingletons.has(binding)) {
      throw new AsyncBindingError(id);
    }
    const requestEntry =
      binding.scope === Scope.Request ? ctx.requestCache?.get(binding) : undefined;
    if (requestEntry) {
      if (!requestEntry.settled) throw new AsyncBindingError(id);
      return requestEntry.value as T;
    }

    const frame: Frame = { binding, parent: caller };
    try {
      return enterStore({ ctx, frame }, () => {
        const instance = this._produceSync(binding, id);
        if (binding.scope === Scope.Singleton) {
          binding.cache = instance;
          binding.cached = true;
        } else if (binding.scope === Scope.Request) {
          const cache = ctx.requestCache ??= new Map();
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
    caller: Frame | undefined = activeFrame(currentStore()?.frame),
  ): Promise<Resolved<T>> {
    if (binding.type === BindingType.Constant) {
      return Promise.resolve({ value: binding.value as T });
    }

    const ctx = currentStore()!.ctx;
    if (binding.scope === Scope.Singleton && binding.cached) {
      return Promise.resolve({ value: binding.cache as T });
    }

    // Reentry of the binding now being constructed is a cycle. A sibling
    // lookup passes the parent frame, so it may share the in-flight promise.
    if (frameHas(caller, binding)) {
      throw new CircularDependencyError(cycleIds(caller, binding));
    }

    if (binding.scope === Scope.Singleton) {
      const pending = pendingSingletons.get(binding);
      if (pending) return waitFor(caller, pending.frame, pending.ready as Promise<Resolved<T>>);
    }

    const requestEntry =
      binding.scope === Scope.Request ? ctx.requestCache?.get(binding) : undefined;
    if (requestEntry) {
      if (requestEntry.settled) return Promise.resolve({ value: requestEntry.value as T });
      return waitFor(caller, requestEntry.frame!, requestEntry.promise as Promise<Resolved<T>>);
    }

    const frame: Frame = { binding, parent: caller, async: true };
    const release = addDependency(caller, frame);
    const store: Store = { ctx, frame };

    const promise = enterStore(store, () => {
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
    pending.catch(() => {});
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

  /** Native continuations inherit this factory's store until its promise settles. */
  private _callFactory<T>(factory: (ctx: FactoryResolutionContext) => T): T {
    const store = currentStore()!;
    return factoryStorage.run(store, () => factory(this._factoryContext(store)));
  }

  private _produceSync<T>(binding: Binding<T>, id: ServiceIdentifier<T>): T {
    if (binding.type === BindingType.Factory) return this._callFactory(binding.factory!);
    if (binding.type === BindingType.AsyncFactory) throw new AsyncBindingError(id);
    return this._createInstance(binding.implementationClass as Constructor<T>);
  }

  private async _produceAsync<T>(binding: Binding<T>): Promise<Resolved<T>> {
    if (binding.type === BindingType.AsyncFactory) {
      return { value: await this._callFactory(binding.asyncFactory!) };
    }
    if (binding.type === BindingType.Factory) return { value: this._callFactory(binding.factory!) };
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
    const store = currentStore()!;
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
      instance = enterStore(store, () => new ctor(...args));
    } else {
      // Keep getAsync construction deferred, including in runtimes without native async context.
      await Promise.resolve();
      instance = enterStore(store, () => new ctor());
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
      const { value } = await enterStore(store, () => this._resolveAsync(token, {
        named: namedMap?.get(fieldName),
        tags: taggedMap?.get(fieldName),
      }));
      enterStore(store, () => this._assign(instance, ctor, metadata, fieldName, value));
    }

    for (const [fieldName, token] of multiMap ?? []) {
      const values = await enterStore(store, () => this._resolveAllAsync(token, {
        named: namedMap?.get(fieldName),
        tags: taggedMap?.get(fieldName),
      }));
      enterStore(store, () => this._assign(instance, ctor, metadata, fieldName, values));
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
