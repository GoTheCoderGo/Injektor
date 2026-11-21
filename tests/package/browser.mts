import { Container, createToken } from "@ilya_coder/injektor";

const c = new Container();
const request = createToken<object>("request");
c.bind(request).toFactory(() => ({})).inRequestScope();
c.bind("root").toAsyncFactory(async ctx => {
  const first = ctx.get(request);
  await Promise.resolve();
  if (first !== ctx.get(request)) throw new Error("browser request scope was lost");
});
await c.getAsync("root");
