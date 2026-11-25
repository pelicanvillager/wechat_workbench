#!/bin/zsh
set -eu
launcher_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"
if ! command -v python3 >/dev/null; then
  print -u2 '需要 Python 3.9 或更新版本。'
  exit 1
fi
exec python3 -B "$launcher_dir/workbench.py" --open "$@"
