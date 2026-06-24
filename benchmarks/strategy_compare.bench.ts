import { run, bench, group } from "mitata";
import { SetResolutionStack, ArrayResolutionStack } from "../src/resolution-stack.ts";
import { Container } from "../index.ts";
import { INJECTABLE_KEY, CONSTRUCTOR_INJECT_KEY } from "../src/consts.ts";

const METADATA_SYMBOL = Symbol.for("Symbol.metadata");

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: Pure Collection Lookup (Set.has vs Array.includes)
// ─────────────────────────────────────────────────────────────────────────────

const targetKey = "non-existent-key";

for (const size of [5, 15, 50, 500]) {
  const arr = Array.from({ length: size }, (_, i) => `id-${i}`);
  const set = new Set(arr);

  group(`1. Pure Lookup in collection of size ${size}`, () => {
    bench("Array.includes (miss)", () => {
      return arr.includes(targetKey);
    });

    bench("Set.has (miss)", () => {
      return set.has(targetKey);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: Deep Linear Resolution (Forks > Lookups)
// ─────────────────────────────────────────────────────────────────────────────

function setupDeepContainer(depth: number, strategy: "set" | "array") {
  const container = new Container({ resolutionStrategy: strategy });
  const classes: any[] = [];

  for (let i = 0; i < depth; i++) {
    class Node {
      constructor(public dep?: any) {}
    }
    Object.defineProperty(Node, "name", { value: `Node${i}` });

    const deps = i > 0 ? [classes[i - 1]] : [];
    (Node as any)[METADATA_SYMBOL] = {
      [INJECTABLE_KEY]: true,
      [CONSTRUCTOR_INJECT_KEY]: deps,
    };

    classes.push(Node);
    container.bind(Node).toSelf().inTransientScope();
  }

  return { container, root: classes[depth - 1] };
}

for (const depth of [20, 200]) {
  const arraySuite = setupDeepContainer(depth, "array");
  const setSuite = setupDeepContainer(depth, "set");

  group(`2. Deep Linear Resolution (Depth: ${depth})`, () => {
    bench("Array Strategy (expected faster)", () => {
      arraySuite.container.get(arraySuite.root);
    });

    bench("Set Strategy (expected slower)", () => {
      setSuite.container.get(setSuite.root);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: Deep Stack + Leaf Singletons (Lookups >> Forks)
// ─────────────────────────────────────────────────────────────────────────────

function setupLeafCachedSingletonsContainer(depth: number, mSingletons: number, strategy: "set" | "array") {
  const container = new Container({ resolutionStrategy: strategy });
  
  const singletonClasses: any[] = [];
  for (let i = 0; i < mSingletons; i++) {
    class SingletonDep {}
    Object.defineProperty(SingletonDep, "name", { value: `SingletonDep${i}` });
    (SingletonDep as any)[METADATA_SYMBOL] = { [INJECTABLE_KEY]: true };
    singletonClasses.push(SingletonDep);
    container.bind(SingletonDep).toSelf().inSingletonScope();
    container.get(SingletonDep); // cache the singleton instance
  }

  class Node0 {
    constructor(...args: any[]) {}
  }
  (Node0 as any)[METADATA_SYMBOL] = {
    [INJECTABLE_KEY]: true,
    [CONSTRUCTOR_INJECT_KEY]: singletonClasses,
  };
  container.bind(Node0).toSelf().inTransientScope();

  const transientClasses: any[] = [Node0];
  for (let i = 1; i < depth; i++) {
    class Node {
      constructor(public dep?: any) {}
    }
    Object.defineProperty(Node, "name", { value: `Node${i}` });

    (Node as any)[METADATA_SYMBOL] = {
      [INJECTABLE_KEY]: true,
      [CONSTRUCTOR_INJECT_KEY]: [transientClasses[i - 1]],
    };

    transientClasses.push(Node);
    container.bind(Node).toSelf().inTransientScope();
  }

  return { container, root: transientClasses[depth - 1] };
}

for (const config of [
  { depth: 15, singletons: 2000 },
  { depth: 30, singletons: 5000 },
]) {
  const arraySuite = setupLeafCachedSingletonsContainer(config.depth, config.singletons, "array");
  const setSuite = setupLeafCachedSingletonsContainer(config.depth, config.singletons, "set");

  group(`3. Sweet Spot: Leaf Singletons (Depth: ${config.depth}, Singletons: ${config.singletons})`, () => {
    bench("Array Strategy (expected slower)", () => {
      arraySuite.container.get(arraySuite.root);
    });

    bench("Set Strategy (expected faster)", () => {
      setSuite.container.get(setSuite.root);
    });
  });
}

await run();
