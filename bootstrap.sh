#!/usr/bin/env bash
# Install dependencies for every extension that declares a package.json.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
extensions_dir="$repo_root/extensions"

if ! command -v npm >/dev/null 2>&1; then
	echo "Error: npm is required but was not found on PATH." >&2
	exit 1
fi

for extension_dir in "$extensions_dir"/*/; do
	[[ -f "$extension_dir/package.json" ]] || continue
	echo "Installing dependencies in ${extension_dir#"$repo_root"/}"

	if [[ -f "$extension_dir/package-lock.json" ]]; then
		(
			cd -- "$extension_dir"
			npm ci
		)
	else
		(
			cd -- "$extension_dir"
			npm install
		)
	fi
done
