// Run each case in its own process, e.g.
// node --expose-gc --import tsx benchmarks/allocations.bench.ts sync
import { getHeapStatistics } from "node:v8";
import { Container, ContainerModule, createToken, inject, injectable, injectConstructor } from "../index.ts";

const scenario = process.argv[2];
const collect = globalThis.gc;
if (!collect) throw new Error("Run with node --expose-gc --import tsx");

const container = new Container();
const request = createToken<object>("request");
const singleton = createToken<number>("singleton");

@injectable()
class Leaf { value = 2; }

@injectable()
@injectConstructor(Leaf, Leaf)
class Pair { constructor(readonly left: Leaf, readonly right: Leaf) {} }

@injectable()
@injectConstructor(Pair, Pair)
class Root { constructor(readonly left: Pair, readonly right: Pair) {} }

@injectable()
@injectConstructor(request)
class Request {
  constructor(readonly first: object) {}
  @inject(request) accessor second!: object;
}

container.bind(Leaf).toSelf();
container.bind(Pair).toSelf();
container.bind(Root).toSelf();
container.bind(Request).toSelf();
container.bind(request).toFactory(() => ({})).inRequestScope();
container.bind(singleton).toFactory(() => 2).inSingletonScope();

async function resolve(count: number): Promise<number> {
  let sum = 0;
  switch (scenario) {
    case "sync":
      for (let i = 0; i < count; i++) sum += container.get(Root).right.right.value;
      break;
    case "async":
      for (let i = 0; i < count; i++) sum += (await container.getAsync(Root)).right.right.value;
      break;
    case "request":
      for (let i = 0; i < count; i++) {
        const value = await container.getAsync(Request);
        sum += Number(value.first === value.second);
      }
      break;
    case "warm-async":
      for (let i = 0; i < count; i++) sum += await container.getAsync(singleton);
      break;
    default:
      throw new Error("Choose sync, async, request, warm-async, classes, children, or module-unbind");
  }
  return sum;
}

function createCatalogEntry(index: number) {
  if (scenario === "classes") {
    @injectable()
    class Service {}
    return Service;
  }
  const child = new Container({ parent: container });
  child.bind("local").toConstant(index);
  return child;
}

if (scenario === "module-unbind") {
  const count = 128;
  container.load(new ContainerModule(bind => {
    bind("keep").toConstant(true);
    for (let i = 0; i < count; i++) {
      bind<number[]>("cache" + i).toFactory(() => Array.from({ length: 32_768 }, (_, n) => n + i)).inSingletonScope();
    }
  }));
  collect();
  const before = getHeapStatistics().used_heap_size;
  for (let i = 0; i < count; i++) {
    if (container.get<number[]>("cache" + i)[0] !== i) throw new Error("Unexpected cache value");
  }
  collect();
  const full = getHeapStatistics().used_heap_size;
  for (let i = 0; i < count; i++) container.unbind("cache" + i);
  collect();
  const after = getHeapStatistics().used_heap_size;
  if (!container.get("keep")) throw new Error("The module must remain loaded");
  console.log(JSON.stringify({ scenario, count, warmedBytes: full - before, retainedAfterUnbind: after - before }));
} else if (scenario === "classes" || scenario === "children") {
  const count = 20_000;
  for (let i = 0; i < 1_000; i++) createCatalogEntry(i);
  collect();
  const before = getHeapStatistics().used_heap_size;
  const catalog = Array.from({ length: count }, (_, index) => createCatalogEntry(index));
  // Keep every entry reachable across collection so the delta measures retained heap.
  Reflect.set(globalThis, "benchmarkCatalog", catalog);
  collect();
  const retainedBytes = getHeapStatistics().used_heap_size - before;
  console.log(JSON.stringify({ scenario, count, retainedBytes }));
} else {
  await resolve(8_000);
  collect();
  const count = scenario === "sync" || scenario === "warm-async" ? 80_000 : 16_000;
  const before = getHeapStatistics().total_allocated_bytes;
  if (before === undefined) throw new Error("This benchmark requires V8's total_allocated_bytes counter");
  const start = performance.now();
  const sum = await resolve(count);
  const nsPerRoot = (performance.now() - start) * 1e6 / count;
  const bytesPerRoot = (getHeapStatistics().total_allocated_bytes - before) / count;
  if (sum !== count * (scenario === "request" ? 1 : 2)) throw new Error("Unexpected resolution result");
  console.log(JSON.stringify({ scenario, count, nsPerRoot, bytesPerRoot }));
}
