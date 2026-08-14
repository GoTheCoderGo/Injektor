# injektor

A lightweight, modern dependency injection library for TypeScript using Stage 3 Decorators.

## Features

- 🪶 **Zero Dependencies:** No runtime dependencies and no peer dependencies for end users.
- 📦 **Stage 3 Decorators:** Built for standard Stage 3 decorators (`Symbol.metadata`).
- 🏷️ **Type-safe Tokens:** Create injection tokens that carry type information for maximum safety.
- 💉 **Flexible Injection:** Support for both constructor injection and property injection (using auto-accessors).
- 🔄 **Scopes:** Control the lifecycle of your dependencies with Transient, Singleton, and Request scopes.
- ⚡ **Autobinding:** Optionally resolve and bind `@injectable()` decorated classes automatically.
- 🦕 **Bun First:** Built with and tested on the Bun runtime.

## Installation

```bash
bun add @ilya_coder/injektor
# or npm
npm install @ilya_coder/injektor
# or pnpm
pnpm add @ilya_coder/injektor
```

`injektor` is lightweight and has **zero runtime dependencies** and **no peer dependencies**.

If you are using TypeScript (5.7+ recommended), ensure your `tsconfig.json` does not enable legacy experimental decorators (i.e. `experimentalDecorators: false` or omitted), as `injektor` uses standard Stage 3 decorators.

## Quick Start

### 1. Define your dependencies

Use the `createToken` function to define type-safe tokens, and decorate your classes with `@injectable()`.

```typescript
import { createToken, injectable, injectConstructor, inject } from "@ilya_coder/injektor";

// Define interfaces
export interface IWeapon {
  name: string;
}

export interface IArmor {
  defense: number;
}

// Define tokens
export const WEAPON = createToken<IWeapon>("Weapon");
export const ARMOR = createToken<IArmor>("Armor");

// Implement dependencies
@injectable()
export class Katana implements IWeapon {
  name = "Katana";
}

@injectable()
export class ChainMail implements IArmor {
  defense = 5;
}
```

### 2. Inject dependencies

You can inject via the **constructor** or via **properties** (auto-accessors).

```typescript
// Constructor Injection
@injectable()
@injectConstructor(WEAPON)
export class Warrior {
  constructor(public weapon: IWeapon) {}
}

// Property Injection (requires 'accessor' keyword)
@injectable()
export class Ninja {
  @inject(WEAPON) accessor weapon!: IWeapon;
  @inject(ARMOR) accessor armor!: IArmor;
}
```

### 3. Setup the Container and resolve

```typescript
import { Container } from "@ilya_coder/injektor";

const container = new Container();

// Bind tokens to implementations
container.bind(WEAPON).to(Katana);
container.bind(ARMOR).to(ChainMail);
container.bind(Ninja).toSelf(); // Bind class to itself

// Resolve
const ninja = container.get(Ninja);

console.log(ninja.weapon.name); // "Katana"
console.log(ninja.armor.defense); // 5
```

## Scopes

You can define the lifecycle of your injected dependencies.

- **Transient (Default):** A new instance is created every time the dependency is requested.
- **Singleton:** The same instance is returned every time.
- **Request:** Instances are shared within a single `.get()` resolution tree, but different across multiple calls.

```typescript
container.bind(WEAPON).to(Katana).inSingletonScope();
container.bind(ARMOR).to(ChainMail).inTransientScope();
container.bind(Warrior).toSelf().inRequestScope();
```

You can also define the default scope directly in the `@injectable` decorator:

```typescript
import { Scope } from "@ilya_coder/injektor";

@injectable({ scope: Scope.Singleton })
export class Configuration {
  // ...
}
```

## Autobinding

If you don't want to manually bind every single class, you can enable `autoBindInjectable`. The container will automatically resolve and bind any requested class decorated with `@injectable()`.

```typescript
const container = new Container({ autoBindInjectable: true });

@injectable()
class AutoSword {
  name = "AutoSword";
}

// No explicit `.bind()` call needed
const sword = container.get(AutoSword);
```

## Error Handling

`injektor` provides explicit custom errors for common mistakes:

- `ServiceNotFoundError`: Thrown when a token/class hasn't been bound.
- `CircularDependencyError`: Thrown when an injection cycle is detected.
- `NotInjectableError`: Thrown when trying to resolve a class not decorated with `@injectable()`.
- `InvalidDecoratorUsageError`: Thrown on incorrect decorator placement.

## Running Tests (for contributors)

```bash
bun test
```
