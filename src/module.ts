import type { ServiceIdentifier } from "./types.ts";
import type { BindingBuilder } from "./binding.ts";

/**
 * The function signature provided to a ContainerModule's registry callback.
 */
export type BindFunction = <T>(id: ServiceIdentifier<T>) => BindingBuilder<T>;

/**
 * Groups related bindings into a reusable module.
 * Load into a container with `container.load(module)`.
 *
 * @example
 * ```ts
 * const weaponModule = new ContainerModule((bind) => {
 *   bind(WEAPON).to(Katana).inSingletonScope();
 *   bind(ARMOR).to(ChainMail);
 * });
 *
 * container.load(weaponModule);
 * container.unload(weaponModule);
 * ```
 */
export class ContainerModule {
  constructor(
    public readonly registry: (bind: BindFunction) => void,
  ) {}
}
