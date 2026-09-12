#!/usr/bin/env bash
# Build and run the C++ embedder demo against the kernel cdylib (Git Bash / Linux).
# All build artifacts stay inside the project directory.
#
# Usage (from the project root): bash examples/cpp-embedder-demo/build.sh [debug|release]
set -euo pipefail

profile="${1:-debug}"
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dll_path="$project_root/rust/target/$profile/extensions_kernel.dll"
so_path="$project_root/rust/target/$profile/libextensions_kernel.so"
build_dir="$project_root/examples/cpp-embedder-demo/build"

if [[ ! -f "$dll_path" && ! -f "$so_path" ]]; then
  echo "kernel cdylib not found, building $profile..."
  if [[ "$profile" == "release" ]]; then
    cargo build --manifest-path "$project_root/rust/Cargo.toml" --release -p extensions-kernel
  else
    cargo build --manifest-path "$project_root/rust/Cargo.toml" -p extensions-kernel
  fi
fi

library_path="$dll_path"
[[ -f "$library_path" ]] || library_path="$so_path"

mkdir -p "$build_dir"
g++ -std=c++17 -O2 "$project_root/examples/cpp-embedder-demo/host.cpp" -o "$build_dir/host" -ldl

cd "$project_root"
"$build_dir/host" "$library_path"
