import type { Constructor, ServiceIdentifier, Binding } from "./types.ts";
import { Scope, BindingType } from "./types.ts";

/**
 * Fluent API builder for configuring a binding.
 * Returned by `container.bind()`.
 *
 * @example
 * ```ts
 * container.bind(WEAPON_TOKEN).to(Katana).inSingletonScope();
 * container.bind(CONFIG).toConstant({ debug: true });
 * container.bind(WEAPON_TOKEN).toFactory(() => new Katana());
 * container.bind(Katana).toSelf();
 * ```
 */
export class BindingBuilder<T> {
  private readonly _binding: Binding<T>;

  constructor(
    id: ServiceIdentifier<T>,
    private readonly _onComplete: (binding: Binding<T>) => void,
  ) {
    this._binding = {
      id,
      type: BindingType.Instance,
      scope: Scope.Transient,
    };
  }

  /**
   * Bind the identifier to a concrete implementation class.
   */
  to(impl: Constructor<T>): this {
    this._binding.type = BindingType.Instance;
    this._binding.implementationClass = impl;
    this._commit();
    return this;
  }

  /**
   * Bind the identifier to itself (the identifier must be a class constructor).
   */
  toSelf(): this {
    const id = this._binding.id;
    if (typeof id !== "function") {
      throw new Error(
        `toSelf() can only be used when the service identifier is a class constructor.`
      );
    }
    return this.to(id as Constructor<T>);
  }

  /**
   * Bind the identifier to a constant value. Always singleton-scoped.
   */
  toConstant(value: T): this {
    this._binding.type = BindingType.Constant;
    this._binding.scope = Scope.Singleton;
    this._binding.value = value;
    this._commit();
    return this;
  }

  /**
   * Bind the identifier to a factory function that produces the value.
   */
  toFactory(factory: () => T): this {
    this._binding.type = BindingType.Factory;
    this._binding.factory = factory;
    this._commit();
    return this;
  }

  /**
   * Set the binding scope to Singleton.
   * The same instance is reused for every resolution.
   */
  inSingletonScope(): this {
    this._binding.scope = Scope.Singleton;
    this._recommit();
    return this;
  }

  /**
   * Set the binding scope to Transient (default).
   * A new instance is created for every resolution.
   */
  inTransientScope(): this {
    this._binding.scope = Scope.Transient;
    this._recommit();
    return this;
  }

  /**
   * Set the binding scope to Request.
   * A single instance is shared within one `container.get()` call graph.
   */
  inRequestScope(): this {
    this._binding.scope = Scope.Request;
    this._recommit();
    return this;
  }

  /** Register the binding with the container. */
  private _commit(): void {
    this._onComplete(this._binding);
  }

  /** Re-register after scope change (binding already exists). */
  private _recommit(): void {
    this._onComplete(this._binding);
  }
}
