#!/usr/bin/env bash
# Build the Claw Machine Web Lens: bundle + minify into dist/, zip with index.html at the root.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist && find dist -mindepth 1 -delete
npx -y esbuild@0.25.12 src/main.js --bundle --minify --format=esm --target=es2020 \
  --alias:three=./vendor/three.module.js --outfile=dist/bundle.js --log-level=warning
cp src/index.html dist/
cp -R public/. dist/
rm -f claw-machine.zip
(cd dist && zip -qr ../claw-machine.zip . -x '.DS_Store')
ls -la dist claw-machine.zip
