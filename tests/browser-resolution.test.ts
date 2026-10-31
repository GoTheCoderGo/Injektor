import { it, expect } from "bun:test";

it("isolates browser graphs and preserves explicit factory contexts across await", async () => {
  const fixture = new URL("./fixtures/browser-resolution.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, fixture], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    requestsAreIsolated: true,
    factoryRequestIsShared: true,
    propertyRequestIsShared: true,
    propertyGraphsAreIsolated: true,
    selectedItems: ["selected"],
    singletonIsShared: true,
    directCycle: true,
    parallelCycle: true,
  });
});
