import { run, bench, group } from "mitata";
import { Container } from "../index.ts";
import { INJECTABLE_KEY, CONSTRUCTOR_INJECT_KEY } from "../src/consts.ts";

const METADATA_SYMBOL = Symbol.for("Symbol.metadata");

// ─────────────────────────────────────────────────────────────────────────────
// Setup: Deep Linear Graph (100 levels)
// ─────────────────────────────────────────────────────────────────────────────

const linearContainer = new Container();
const linearClasses: any[] = [];

for (let i = 0; i < 100; i++) {
  class Node {
    constructor(public dep?: any) {}
  }
  Object.defineProperty(Node, "name", { value: `LinearNode${i}` });

  const deps = i > 0 ? [linearClasses[i - 1]] : [];
  (Node as any)[METADATA_SYMBOL] = {
    [INJECTABLE_KEY]: true,
    [CONSTRUCTOR_INJECT_KEY]: deps,
  };

  linearClasses.push(Node);
  linearContainer.bind(Node).toSelf().inTransientScope();
}
const LinearRoot = linearClasses[99];


// ─────────────────────────────────────────────────────────────────────────────
// Setup: Wide Graph (Root with 100 dependencies)
// ─────────────────────────────────────────────────────────────────────────────

const wideContainer = new Container();
const wideDeps: any[] = [];

for (let i = 0; i < 100; i++) {
  class Dep {}
  Object.defineProperty(Dep, "name", { value: `WideDep${i}` });
  (Dep as any)[METADATA_SYMBOL] = { [INJECTABLE_KEY]: true };
  wideDeps.push(Dep);
  wideContainer.bind(Dep).toSelf().inTransientScope();
}

class WideRoot {
  constructor(...deps: any[]) {}
}
(WideRoot as any)[METADATA_SYMBOL] = {
  [INJECTABLE_KEY]: true,
  [CONSTRUCTOR_INJECT_KEY]: wideDeps,
};
wideContainer.bind(WideRoot).toSelf().inTransientScope();


// ─────────────────────────────────────────────────────────────────────────────
// Setup: Diamond/Exponential Graph (Depth 12, Branching 3)
// ─────────────────────────────────────────────────────────────────────────────

const expContainer = new Container();
const expClasses: any[] = [];
// This creates a DAG where each node depends on the 3 previous nodes.
// Because it's Transient scope, it resolves exponentially.
// Depth 12 with 3 branches results in thousands of instances created per resolution.

for (let i = 0; i < 12; i++) {
  class ExpNode {
    constructor(...deps: any[]) {}
  }
  Object.defineProperty(ExpNode, "name", { value: `ExpNode${i}` });

  const deps = [];
  if (i > 0) {
    for (let j = Math.max(0, i - 3); j < i; j++) {
      deps.push(expClasses[j]);
    }
  }

  (ExpNode as any)[METADATA_SYMBOL] = {
    [INJECTABLE_KEY]: true,
    [CONSTRUCTOR_INJECT_KEY]: deps,
  };

  expClasses.push(ExpNode);
  expContainer.bind(ExpNode).toSelf().inTransientScope();
}
const ExpRoot = expClasses[11];

// Also set up a Singleton version of the Exponential Graph
const expSingletonContainer = new Container();
for (let i = 0; i < 12; i++) {
  expSingletonContainer.bind(expClasses[i]).toSelf().inSingletonScope();
}


// ─────────────────────────────────────────────────────────────────────────────
// Benchmarks
// ─────────────────────────────────────────────────────────────────────────────

group("Heavy: Deep Linear Graph (Depth 100)", () => {
  bench("Resolve 100 nested transient dependencies", () => {
    linearContainer.get(LinearRoot);
  });
});

group("Heavy: Wide Graph (100 arguments)", () => {
  bench("Resolve 1 object with 100 transient dependencies", () => {
    wideContainer.get(WideRoot);
  });
});

group("Heavy: Exponential DAG (Depth 12, Branching 3)", () => {
  bench("Resolve Transient (creates thousands of instances)", () => {
    expContainer.get(ExpRoot);
  });

  bench("Resolve Singleton (caches instances)", () => {
    expSingletonContainer.get(ExpRoot);
  });
});

await run();
