import { expect, it } from "bun:test";
import { runInNewContext } from "node:vm";
import { CircularDependencyError, Container, createToken } from "../index.ts";

it("tracks the caller of a deferred provider between concurrent singleton roots", async () => {
  const c = new Container();
  const left = createToken<string>("left");
  const right = createToken<string>("right");
  const provider = createToken<() => Promise<string>>("provide right");
  const gate = Promise.withResolvers<void>();
  c.bind(provider).toFactory(ctx => () => ctx.getAsync(right));
  c.bind(left).toAsyncFactory(async ctx => {
    await gate.promise;
    return ctx.get(provider)();
  }).inSingletonScope();
  c.bind(right).toAsyncFactory(async ctx => {
    await gate.promise;
    return ctx.getAsync(left);
  }).inSingletonScope();

  const results = Promise.allSettled([c.getAsync(left), c.getAsync(right)]);
  gate.resolve();
  for (const result of await results) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBeInstanceOf(CircularDependencyError);
  }
  c.rebind(right).toConstant("ready");
  expect(await c.getAsync(left)).toBe("ready");
}, 1000);

it("also detects the wait when a sync factory starts its async dependency immediately", async () => {
  const c = new Container();
  const ready = Promise.withResolvers<void>();
  const pending = createToken<Promise<string>>("pending right");
  c.bind(pending).toFactory(ctx => ctx.getAsync<string>("right"));
  c.bind<string>("left").toAsyncFactory(async ctx => {
    await ready.promise;
    return ctx.get(pending);
  }).inSingletonScope();
  c.bind<string>("right").toAsyncFactory(async ctx => {
    await ready.promise;
    return ctx.getAsync<string>("left");
  }).inSingletonScope();
  const results = Promise.allSettled([c.getAsync("left"), c.getAsync("right")]);
  ready.resolve();
  for (const result of await results) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBeInstanceOf(CircularDependencyError);
  }
}, 1000);

it("starts a fresh graph for each timer tick after factory initialization completes", async () => {
  const c = new Container();
  const request = createToken<object>("request");
  c.bind(request).toFactory(() => ({})).inRequestScope();
  const done = Promise.withResolvers<void>();
  const ticks: object[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  c.bind("worker").toAsyncFactory(async ctx => {
    timer = setInterval(() => {
      ticks.push(c.get(request));
      if (ticks.length === 2) done.resolve();
    }, 1);
    return ctx.get(request);
  });
  try {
    const initial = await c.getAsync("worker");
    await done.promise;
    expect(new Set([initial, ...ticks]).size).toBe(3);
  } finally {
    clearInterval(timer);
  }
});

it("preserves native context for a promise returned by a synchronous factory", async () => {
  const c = new Container();
  const request = createToken<object>("request");
  const service = createToken<Promise<object[]>>("service");
  c.bind(request).toFactory(() => ({})).inRequestScope();
  c.bind(service).toFactory(async () => {
    const first = c.get(request);
    await Promise.resolve();
    return [first, c.get(request)];
  });
  const [a, b] = await Promise.all([c.get(service), c.getAsync(service)]);
  expect(a[0]).toBe(a[1]);
  expect(b[0]).toBe(b[1]);
  expect(a[0]).not.toBe(b[0]);
});

it("recognizes a factory's native promise from a different realm", async () => {
  const c = new Container();
  const request = createToken<object>("request");
  const service = createToken<Promise<object[]>>("foreign promise");
  const readTwice: (read: () => object) => Promise<object[]> = runInNewContext(
    "(async read => { const first = read(); await 0; return [first, read()]; })",
  );
  c.bind(request).toFactory(() => ({})).inRequestScope();
  c.bind(service).toFactory(() => readTwice(() => c.get(request)));
  const result = c.get(service);
  expect(result).not.toBeInstanceOf(Promise);
  const [first, second] = await result;
  expect(first).toBe(second);
});

it("does not start a lazy singleton thenable during async multi-resolution", async () => {
  const c = new Container();
  const token = createToken<PromiseLike<number>>("query");
  let starts = 0;
  const query: PromiseLike<number> = {
    then(resolve, reject) { return Promise.resolve(++starts).then(resolve, reject); },
  };
  c.bind(token).toFactory(() => query).inSingletonScope();
  const [[a], [b]] = await Promise.all([c.getAllAsync(token), c.getAllAsync(token)]);
  expect(a).toBe(query);
  expect(b).toBe(query);
  expect(starts).toBe(0);
  expect(await c.getAsync(token)).toBe(1);
});

for (const asyncLookup of [false, true]) {
  it(`shares an inherited request with a cold parent singleton (async = ${asyncLookup})`, async () => {
    const parent = new Container();
    const child = new Container({ parent });
    const request = createToken<object>("request");
    const singleton = createToken<object>("singleton");
    const root = createToken<object[]>("root");
    let calls = 0;
    parent.bind("config").toConstant("parent");
    child.bind("config").toConstant("child");
    parent.bind(request).toFactory(ctx => ({ call: ++calls, config: ctx.get("config") })).inRequestScope();
    if (asyncLookup) {
      parent.bind(singleton).toAsyncFactory(ctx => ctx.getAsync(request)).inSingletonScope();
      child.bind(root).toAsyncFactory(ctx => Promise.all([ctx.getAsync(request), ctx.getAsync(singleton)]));
    } else {
      parent.bind(singleton).toFactory(ctx => ctx.get(request)).inSingletonScope();
      child.bind(root).toFactory(ctx => [ctx.get(request), ctx.get(singleton)]);
    }
    const [direct, indirect] = asyncLookup ? await child.getAsync(root) : child.get(root);
    expect(direct).toBe(indirect);
    expect(direct).toEqual({ call: 1, config: "parent" });
    expect(child.get(request)).not.toBe(direct);
  });

  it(`retains the owner of a removed multi-binding (async = ${asyncLookup})`, async () => {
    const parent = new Container();
    const child = new Container({ parent });
    parent.bind("config").toConstant("parent");
    child.bind("config").toConstant("child");
    child.bind("group").toFactory(() => { child.unbind("group"); return "first"; });
    child.bind("group").toFactory(ctx => ctx.get("config")).inSingletonScope();
    expect(asyncLookup ? await child.getAllAsync("group") : child.getAll("group")).toEqual(["first", "child"]);
    expect(child.isBound("group")).toBe(false);
  });
}

it("discards warm and pending singleton caches when the binding changes scope", async () => {
  const c = new Container();
  let calls = 0;
  const warmToken = createToken<number>("warm");
  const warm = c.bind(warmToken).toFactory(() => ++calls).inSingletonScope();
  expect(c.get(warmToken)).toBe(1);
  warm.inTransientScope();
  expect(c.get(warmToken)).toBe(2);
  warm.inSingletonScope();
  expect(c.get(warmToken)).toBe(3);

  const first = Promise.withResolvers<number>();
  const second = Promise.withResolvers<number>();
  const pendingToken = createToken<number>("pending");
  let attempts = 0;
  const pending = c.bind(pendingToken).toAsyncFactory(() => ++attempts === 1 ? first.promise : second.promise).inSingletonScope();
  const old = c.getAsync(pendingToken);
  pending.inRequestScope().inSingletonScope();
  const current = c.getAsync(pendingToken);
  second.resolve(2);
  expect(await current).toBe(2);
  first.resolve(1);
  expect(await old).toBe(1);
  expect(c.get(pendingToken)).toBe(2);
});
