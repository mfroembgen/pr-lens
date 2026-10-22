#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -xzf "$1" -C "$work"
cp "$root/packages/schema/examples/minimal.graph.json" "$work/graph.json"
mkdir "$work/home" "$work/empty-path"
cd "$work"

cli() {
  env -i HOME="$work/home" PATH="$work/empty-path" "$work/pr-lens" "$@"
}

cli --version
cli publish --help > publish-help.txt
cli skill > skill.md
cli skill references > references.md
test -s publish-help.txt
test -s skill.md
test -s references.md
cli validate graph.json
cli render graph.json --no-config --out preview
cli validate preview/drawn.graph.json preview/manifest.json
for svg in preview/*.svg; do
  test -s "$svg"
done
cli comment --target gitlab --graph preview/drawn.graph.json \
  --manifest preview/manifest.json --asset-base-url https://example.com \
  --out preview.md
test -s preview.md
printf '{}\n' > invalid.json
if cli validate invalid.json > /dev/null 2>&1; then
  echo 'Invalid input unexpectedly succeeded' >&2
  exit 1
fi
