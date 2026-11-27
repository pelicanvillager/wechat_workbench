#!/bin/zsh
set -eu
launcher_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"
# Finder 的 PATH 可能找不到 Codex，优先查找 macOS 应用自带的 CLI。
codex_app='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
if [[ -x "$codex_app" && -z "${WECHAT_WORKBENCH_CODEX:-}" ]] && ! command -v codex >/dev/null; then
  export WECHAT_WORKBENCH_CODEX="$codex_app"
fi
if ! command -v python3 >/dev/null; then
  print -u2 '需要 Python 3.9 或更新版本。'
  exit 1
fi
exec python3 -B "$launcher_dir/workbench.py" --open "$@"
