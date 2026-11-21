import { $ } from "bun";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import * as api from "../index.ts";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await $`bun x tsc --project tsconfig.build.json --outDir dist`;

// Both declaration entry points refer to the same classes, including their private members.
await writeFile("dist/src/package.json", '{"type":"commonjs"}\n');
await copyFile("dist/index.d.ts", "dist/index.d.cts");

await $`bun build index.ts --outfile dist/index.js --target browser`;
await $`bun build index.ts --outfile dist/index.cjs --format cjs --target node`;
const names = Object.keys(api).sort().join(", ");
await writeFile("dist/node.js", `import runtime from "./index.cjs";\nexport const { ${names} } = runtime;\n`);
