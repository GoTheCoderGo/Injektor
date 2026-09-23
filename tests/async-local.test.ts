import { describe, expect, it } from "bun:test";
import { PromiseAsyncLocalStorage } from "../src/async-local.ts";

const als = new PromiseAsyncLocalStorage<string>();

describe("Promise async context", () => {
  it("restores the outer store around a nested run", () => {
    const seen = als.run("outer", () => {
      const inner = als.run("inner", () => als.getStore());
      return { inner, outer: als.getStore() };
    });
    expect(seen).toEqual({ inner: "inner", outer: "outer" });
    expect(als.getStore()).toBeUndefined();
  });

  it("keeps the store inside a then callback registered during run", async () => {
    const seen = await als.run("A", () => Promise.resolve(1).then(() => als.getStore()));
    expect(seen).toBe("A");
    expect(als.getStore()).toBeUndefined();
  });

  it("keeps the store across await until the callback promise settles", async () => {
    const seen = await als.run("A", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return als.getStore();
    });
    expect(seen).toBe("A");
    expect(als.getStore()).toBeUndefined();
  });
});
