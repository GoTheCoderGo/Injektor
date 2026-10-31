// Import the library only after hiding native storage, in a dedicated process.
(process as unknown as { getBuiltinModule?: unknown }).getBuiltinModule = undefined;
const {
  Container, injectable, injectConstructor, inject, multiInject, named,
  createToken, CircularDependencyError,
} = await import("../../index.ts");

const c = new Container();
const dep = createToken<object>("request dependency");
const root = createToken<{ before: object; after: object }>("factory");
let calls = 0;
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
c.bind(dep).toFactory(() => ({ call: ++calls })).inRequestScope();
c.bind(root).toAsyncFactory(async (ctx) => {
  const before = ctx.get(dep);
  await gate;
  const after = await ctx.getAsync(dep);
  return { before, after };
});
const first = c.getAsync(root);
const second = c.getAsync(root);
const outside = c.get(dep);
release();
const [a, b] = await Promise.all([first, second]);

// Constructor callbacks and multiple property awaits must stay in the graph.
const item = createToken<string>("item");
c.bind(item).toAsyncFactory(async () => "selected").whenNamed("selected");
c.bind(item).toAsyncFactory(async () => "other").whenNamed("other");
@injectable()
@injectConstructor(dep)
class Graph {
  fromConstructor: object;
  constructor(public arg: object) { this.fromConstructor = c.get(dep); }
  @inject(dep) accessor first!: object;
  @inject(dep) accessor second!: object;
  @multiInject(item) @named("selected") accessor items!: string[];
}
c.bind(Graph).toSelf();
const [graphA, graphB] = await Promise.all([c.getAsync(Graph), c.getAsync(Graph)]);

// A concurrent singleton lookup after another microtask is still a dedupe.
const singleton = createToken<object>("singleton");
let singletonCalls = 0;
let releaseSingleton!: () => void;
const singletonGate = new Promise<void>((resolve) => { releaseSingleton = resolve; });
c.bind(singleton).toAsyncFactory(async () => {
  singletonCalls++;
  await singletonGate;
  return {};
}).inSingletonScope();
const singletonA = c.getAsync(singleton);
await Promise.resolve();
const singletonB = c.getAsync(singleton);
releaseSingleton();
const singletonValues = await Promise.all([singletonA, singletonB]);

// Scoped factory lookup after await must detect both direct and parallel cycles.
const loop = createToken<object>("loop");
c.bind(loop).toAsyncFactory(async (ctx) => {
  await Promise.resolve();
  return ctx.getAsync(loop);
}).inSingletonScope();
let directCycle = false;
try { await c.getAsync(loop); }
catch (err) { directCycle = err instanceof CircularDependencyError; }

const left = createToken<object>("left");
const right = createToken<object>("right");
c.bind(left).toAsyncFactory(async (ctx) => { await Promise.resolve(); return ctx.getAsync(right); }).inSingletonScope();
c.bind(right).toAsyncFactory(async (ctx) => { await Promise.resolve(); return ctx.getAsync(left); }).inSingletonScope();
@injectable()
@injectConstructor(left, right)
class Cycle { constructor(public a: object, public b: object) {} }
c.bind(Cycle).toSelf();
let parallelCycle = false;
let watchdog: ReturnType<typeof setTimeout>;
try {
  await Promise.race([
    c.getAsync(Cycle),
    new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error("cycle timed out")), 500);
    }),
  ]);
} catch (err) { parallelCycle = err instanceof CircularDependencyError; }
finally { clearTimeout(watchdog!); }

console.log(JSON.stringify({
  requestsAreIsolated: a.before !== b.before && outside !== a.before && outside !== b.before,
  factoryRequestIsShared: a.before === a.after && b.before === b.after,
  propertyRequestIsShared: [graphA, graphB].every((g) =>
    g.arg === g.fromConstructor && g.arg === g.first && g.arg === g.second),
  propertyGraphsAreIsolated: graphA.arg !== graphB.arg,
  selectedItems: graphA.items,
  singletonIsShared: singletonValues[0] === singletonValues[1] && singletonCalls === 1,
  directCycle,
  parallelCycle,
}));
