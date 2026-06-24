import {
  INJECTABLE_KEY,
  CONSTRUCTOR_INJECT_KEY,
  PROPERTY_INJECT_KEY,
  NAMED_INJECT_KEY,
  TAGGED_INJECT_KEY,
  MULTI_INJECT_KEY,
} from "./consts.ts";
import {
  ServiceNotFoundError,
  CircularDependencyError,
  NotInjectableError,
  AmbiguousBindingError,
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
  ContainerOptions,
} from "./types.ts";
import { Scope, BindingType } from "./types.ts";

// Polyfill Symbol.metadata for runtimes that don't yet expose it natively.
// @ts-ignore
Symbol.metadata ??= Symbol.for("Symbol.metadata");

/**
 * Normalise an `InjectArg` into an `InjectDescriptor`.
 */
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

/**
 * Check if a binding's tags match all required tags.
 */
function tagsMatch(
  binding: Binding,
  requiredTags: Record<string, unknown>,
): boolean {
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
 * - Multi-injection (`getAll`)
 * - Async factories (`getAsync`)
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

  constructor(options?: ContainerOptions) {
    this._parent = options?.parent;
    this._autoBindInjectable = options?.autoBindInjectable ?? false;
  }

  // ──────────────────────── Binding registration ────────────────────────

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

  // ──────────────────────── Module support ───────────────────────────

  /**
   * Load a `ContainerModule`, executing its registry callback.
   * Bindings added by the module can later be removed with `unload()`.
   */
  load(module: ContainerModule): void {
    const registered: Binding[] = [];

    const bindFn = <T>(id: ServiceIdentifier<T>): BindingBuilder<T> => {
      return new BindingBuilder<T>(id, (binding) => {
        registered.push(binding as Binding);
        this._addBinding(binding as Binding);
      });
    };

    module.registry(bindFn);
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

  // ──────────────────────── Synchronous resolution ──────────────────────

  /**
   * Resolve a single dependency by its service identifier.
   *
   * @throws {ServiceNotFoundError} if no binding exists.
   * @throws {AmbiguousBindingError} if multiple bindings exist (use `getAll`, `getNamed`, or `getTagged`).
   * @throws {CircularDependencyError} if a cycle is detected.
   * @throws {NotInjectableError} if the target class lacks `@injectable()`.
   */
  get<T>(id: ServiceIdentifier<T>): T {
    const requestCache = new Map<ServiceIdentifier, unknown>();
    return this._resolve<T>(id, {}, new Set(), requestCache);
  }

  /**
   * Resolve a dependency by service identifier + named constraint.
   */
  getNamed<T>(id: ServiceIdentifier<T>, name: string): T {
    const requestCache = new Map<ServiceIdentifier, unknown>();
    return this._resolve<T>(id, { named: name }, new Set(), requestCache);
  }

  /**
   * Resolve a dependency by service identifier + tagged constraint.
   */
  getTagged<T>(id: ServiceIdentifier<T>, key: string, value: unknown): T {
    const requestCache = new Map<ServiceIdentifier, unknown>();
    return this._resolve<T>(
      id,
      { tags: { [key]: value } },
      new Set(),
      requestCache,
    );
  }

  /**
   * Resolve ALL bindings for a service identifier.
   * Returns an array of resolved instances.
   */
  getAll<T>(id: ServiceIdentifier<T>): T[] {
    const requestCache = new Map<ServiceIdentifier, unknown>();
    return this._resolveAll<T>(id, new Set(), requestCache);
  }

  // ──────────────────────── Async resolution ────────────────────────

  /**
   * Asynchronously resolve a dependency. Required for `AsyncFactory` bindings.
   * Also works with sync bindings (returns an immediately-resolved promise).
   */
  async getAsync<T>(id: ServiceIdentifier<T>): Promise<T> {
    const requestCache = new Map<ServiceIdentifier, unknown>();
    return this._resolveAsync<T>(id, {}, new Set(), requestCache);
  }

  // ──────────────────────── Private helpers ─────────────────────────

  /** Add a binding to the internal multi-binding store. */
  private _addBinding(binding: Binding): void {
    const list = this._bindings.get(binding.id);
    if (list) {
      list.push(binding);
    } else {
      this._bindings.set(binding.id, [binding]);
    }
  }

  /** Remove a specific binding object from the internal store. */
  private _removeBinding(binding: Binding): void {
    const list = this._bindings.get(binding.id);
    if (!list) return;
    const idx = list.indexOf(binding);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) this._bindings.delete(binding.id);
  }

  /**
   * Look up all bindings for a token in this container and its parent chain.
   */
  private _lookupAll(id: ServiceIdentifier): Binding[] {
    const local = this._bindings.get(id) ?? [];
    const parent = this._parent?._lookupAll(id) ?? [];
    return [...local, ...parent];
  }

  /**
   * Attempt to automatically bind a requested class if autobinding is enabled.
   */
  private _tryAutoBind(id: ServiceIdentifier): void {
    if (this._autoBindInjectable && typeof id === "function") {
      const metadata = (id as any)[Symbol.metadata];
      if (metadata && metadata[INJECTABLE_KEY] === true) {
        this.bind(id as Constructor).toSelf();
      }
    }
  }

  /**
   * Select a single binding matching optional constraints.
   */
  private _selectBinding<T>(
    id: ServiceIdentifier<T>,
    constraints: { named?: string; tags?: Record<string, unknown> },
  ): Binding<T> {
    let all = this._lookupAll(id) as Binding<T>[];
    
    if (all.length === 0) {
      this._tryAutoBind(id);
      all = this._lookupAll(id) as Binding<T>[];
    }

    if (all.length === 0) {
      throw new ServiceNotFoundError(id);
    }

    let candidates = all;

    if (constraints.named !== undefined) {
      candidates = candidates.filter((b) => b.name === constraints.named);
    }

    if (constraints.tags !== undefined) {
      candidates = candidates.filter((b) => tagsMatch(b, constraints.tags!));
    }

    if (candidates.length === 0) {
      throw new ServiceNotFoundError(id);
    }

    if (candidates.length > 1) {
      throw new AmbiguousBindingError(id, candidates.length);
    }

    return candidates[0]!;
  }

  // ──────────────────────── Sync resolution core ────────────────────────

  private _resolve<T>(
    id: ServiceIdentifier<T>,
    constraints: { named?: string; tags?: Record<string, unknown> },
    resolutionStack: Set<ServiceIdentifier>,
    requestCache: Map<ServiceIdentifier, unknown>,
  ): T {
    // ── Circular dependency detection ──
    if (resolutionStack.has(id)) {
      throw new CircularDependencyError([...resolutionStack, id]);
    }

    const binding = this._selectBinding(id, constraints);
    return this._resolveBinding<T>(binding, id, resolutionStack, requestCache);
  }

  private _resolveBinding<T>(
    binding: Binding<T>,
    id: ServiceIdentifier<T>,
    resolutionStack: Set<ServiceIdentifier>,
    requestCache: Map<ServiceIdentifier, unknown>,
  ): T {
    // ── Constant bindings short-circuit ──
    if (binding.type === BindingType.Constant) {
      return binding.value as T;
    }

    // ── Singleton cache hit ──
    if (binding.scope === Scope.Singleton && binding.cache !== undefined) {
      return binding.cache;
    }

    // ── Request-scope cache hit ──
    // Use binding identity as cache key for request scope to support named/tagged.
    const requestKey = binding as unknown as ServiceIdentifier;
    if (binding.scope === Scope.Request && requestCache.has(requestKey)) {
      return requestCache.get(requestKey) as T;
    }

    // ── Resolve the value ──
    const nextStack = new Set(resolutionStack).add(id);
    let instance: T;

    if (binding.type === BindingType.Factory) {
      instance = binding.factory!();
    } else if (binding.type === BindingType.AsyncFactory) {
      throw new Error(
        `Binding for ${String(id)} is an async factory. Use container.getAsync() instead.`
      );
    } else {
      // BindingType.Instance
      instance = this._createInstance<T>(
        binding.implementationClass!,
        nextStack,
        requestCache,
      );
    }

    // ── Cache by scope ──
    if (binding.scope === Scope.Singleton) {
      binding.cache = instance;
    } else if (binding.scope === Scope.Request) {
      requestCache.set(requestKey, instance);
    }

    return instance;
  }

  /**
   * Resolve all bindings for a token as an array.
   */
  private _resolveAll<T>(
    id: ServiceIdentifier<T>,
    resolutionStack: Set<ServiceIdentifier>,
    requestCache: Map<ServiceIdentifier, unknown>,
  ): T[] {
    let all = this._lookupAll(id) as Binding<T>[];
    
    if (all.length === 0) {
      this._tryAutoBind(id);
      all = this._lookupAll(id) as Binding<T>[];
    }

    if (all.length === 0) {
      throw new ServiceNotFoundError(id);
    }
    return all.map((binding) =>
      this._resolveBinding(binding, id, resolutionStack, requestCache),
    );
  }

  // ──────────────────────── Async resolution core ───────────────────────

  private async _resolveAsync<T>(
    id: ServiceIdentifier<T>,
    constraints: { named?: string; tags?: Record<string, unknown> },
    resolutionStack: Set<ServiceIdentifier>,
    requestCache: Map<ServiceIdentifier, unknown>,
  ): Promise<T> {
    if (resolutionStack.has(id)) {
      throw new CircularDependencyError([...resolutionStack, id]);
    }

    const binding = this._selectBinding(id, constraints);

    // ── Constant ──
    if (binding.type === BindingType.Constant) {
      return binding.value as T;
    }

    // ── Singleton cache hit ──
    if (binding.scope === Scope.Singleton && binding.cache !== undefined) {
      return binding.cache;
    }

    // ── Request-scope cache hit ──
    const requestKey = binding as unknown as ServiceIdentifier;
    if (binding.scope === Scope.Request && requestCache.has(requestKey)) {
      return requestCache.get(requestKey) as T;
    }

    const nextStack = new Set(resolutionStack).add(id);
    let instance: T;

    if (binding.type === BindingType.AsyncFactory) {
      instance = await binding.asyncFactory!();
    } else if (binding.type === BindingType.Factory) {
      instance = binding.factory!();
    } else {
      // BindingType.Instance
      instance = await this._createInstanceAsync<T>(
        binding.implementationClass!,
        nextStack,
        requestCache,
      );
    }

    // ── Cache by scope ──
    if (binding.scope === Scope.Singleton) {
      binding.cache = instance;
    } else if (binding.scope === Scope.Request) {
      requestCache.set(requestKey, instance);
    }

    return instance;
  }

  // ──────────────────────── Instance creation ───────────────────────────

  /**
   * Instantiate a class, resolving constructor and property dependencies (sync).
   */
  private _createInstance<T>(
    ctor: Constructor<T>,
    resolutionStack: Set<ServiceIdentifier>,
    requestCache: Map<ServiceIdentifier, unknown>,
  ): T {
    const metadata = (ctor as any)[Symbol.metadata];

    if (!metadata || metadata[INJECTABLE_KEY] !== true) {
      throw new NotInjectableError(ctor);
    }

    // ── Resolve constructor arguments ──
    const ctorArgs =
      (metadata[CONSTRUCTOR_INJECT_KEY] as ConstructorInjectMetadata) ?? [];
    const args = ctorArgs.map((arg) => {
      const desc = normalizeArg(arg);
      if (desc.multi) {
        return this._resolveAll(desc.token, resolutionStack, requestCache);
      }
      return this._resolve(
        desc.token,
        { named: desc.named, tags: desc.tags },
        resolutionStack,
        requestCache,
      );
    });

    // ── Instantiate ──
    const instance = new ctor(...args);

    // ── Property injection ──
    this._injectProperties(instance, metadata, resolutionStack, requestCache);

    return instance;
  }

  /**
   * Instantiate a class, resolving constructor and property dependencies (async).
   */
  private async _createInstanceAsync<T>(
    ctor: Constructor<T>,
    resolutionStack: Set<ServiceIdentifier>,
    requestCache: Map<ServiceIdentifier, unknown>,
  ): Promise<T> {
    const metadata = (ctor as any)[Symbol.metadata];

    if (!metadata || metadata[INJECTABLE_KEY] !== true) {
      throw new NotInjectableError(ctor);
    }

    // ── Resolve constructor arguments (async) ──
    const ctorArgs =
      (metadata[CONSTRUCTOR_INJECT_KEY] as ConstructorInjectMetadata) ?? [];
    const args = await Promise.all(
      ctorArgs.map((arg) => {
        const desc = normalizeArg(arg);
        if (desc.multi) {
          return this._resolveAll(desc.token, resolutionStack, requestCache);
        }
        return this._resolveAsync(
          desc.token,
          { named: desc.named, tags: desc.tags },
          resolutionStack,
          requestCache,
        );
      }),
    );

    // ── Instantiate ──
    const instance = new ctor(...args);

    // ── Property injection (async) ──
    await this._injectPropertiesAsync(
      instance,
      metadata,
      resolutionStack,
      requestCache,
    );

    return instance;
  }

  // ──────────────────────── Property injection ──────────────────────────

  /**
   * Inject all decorated properties on an instance (sync).
   */
  private _injectProperties(
    instance: any,
    metadata: Record<symbol, unknown>,
    resolutionStack: Set<ServiceIdentifier>,
    requestCache: Map<ServiceIdentifier, unknown>,
  ): void {
    const propMap =
      (metadata[PROPERTY_INJECT_KEY] as PropertyInjectMetadata) ?? new Map();
    const namedMap =
      (metadata[NAMED_INJECT_KEY] as NamedInjectMetadata) ?? new Map();
    const taggedMap =
      (metadata[TAGGED_INJECT_KEY] as TaggedInjectMetadata) ?? new Map();
    const multiMap =
      (metadata[MULTI_INJECT_KEY] as MultiInjectMetadata) ?? new Map();

    // @inject() properties
    for (const [fieldName, token] of propMap) {
      const name = namedMap.get(fieldName);
      const tags = taggedMap.get(fieldName);
      const value = this._resolve(
        token,
        { named: name, tags },
        resolutionStack,
        requestCache,
      );
      instance[fieldName] = value;
    }

    // @multiInject() properties
    for (const [fieldName, token] of multiMap) {
      const value = this._resolveAll(token, resolutionStack, requestCache);
      instance[fieldName] = value;
    }
  }

  /**
   * Inject all decorated properties on an instance (async).
   */
  private async _injectPropertiesAsync(
    instance: any,
    metadata: Record<symbol, unknown>,
    resolutionStack: Set<ServiceIdentifier>,
    requestCache: Map<ServiceIdentifier, unknown>,
  ): Promise<void> {
    const propMap =
      (metadata[PROPERTY_INJECT_KEY] as PropertyInjectMetadata) ?? new Map();
    const namedMap =
      (metadata[NAMED_INJECT_KEY] as NamedInjectMetadata) ?? new Map();
    const taggedMap =
      (metadata[TAGGED_INJECT_KEY] as TaggedInjectMetadata) ?? new Map();
    const multiMap =
      (metadata[MULTI_INJECT_KEY] as MultiInjectMetadata) ?? new Map();

    // @inject() properties
    for (const [fieldName, token] of propMap) {
      const name = namedMap.get(fieldName);
      const tags = taggedMap.get(fieldName);
      const value = await this._resolveAsync(
        token,
        { named: name, tags },
        resolutionStack,
        requestCache,
      );
      instance[fieldName] = value;
    }

    // @multiInject() properties
    for (const [fieldName, token] of multiMap) {
      const values = this._resolveAll(token, resolutionStack, requestCache);
      instance[fieldName] = values;
    }
  }
}
