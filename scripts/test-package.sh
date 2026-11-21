#!/bin/sh
set -eu

project=$(pwd)
compiler=${TSC_BIN:-"$project/node_modules/.bin/tsc"}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

bun run build
bun pm pack --ignore-scripts --filename "$work/package.tgz" --quiet
dest="$work/node_modules/@ilya_coder/injektor"
mkdir -p "$dest"
tar -xzf "$work/package.tgz" --strip-components=1 -C "$dest"
cp tests/package/*.mts tests/package/*.cts "$work"
cd "$work"
"$compiler" --version
"$compiler" --strict --target es2022 --lib es2022,decorators --module node16 --outDir out consumer.mts plugin.cts browser.mts
node --unhandled-rejections=strict out/consumer.mjs
bun out/consumer.mjs
bun build browser.mts --target browser --outfile browser.mjs
node --input-type=module -e 'globalThis.process = undefined; await import("./browser.mjs")'
