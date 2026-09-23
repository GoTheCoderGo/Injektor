/**
 * A branded symbol that carries a phantom type parameter `T`.
 * This enables type-safe `container.get<T>(token)` without casting.
 */
export type Token<T = unknown> = symbol & { readonly __type?: T };

/**
 * Creates a typed service identifier token.
 *
 * @param description - A human-readable description for debugging.
 * @returns A unique symbol branded with the phantom type `T`.
 *
 * @example
 * ```ts
 * interface Logger { log(msg: string): void; }
 * const LOGGER = createToken<Logger>("Logger");
 * container.bind(LOGGER).to(ConsoleLogger);
 * const logger = container.get(LOGGER); // typed as Logger
 * ```
 */
export function createToken<T>(description: string): Token<T> {
  return Symbol(description) as Token<T>;
}
