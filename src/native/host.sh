#!/bin/sh
# AutoApply's Claude bridge (macOS/Linux): a Chrome native messaging host that runs the user's own `claude -p`
# once per launch. Request: ["<base64 system prompt>","<base64 prompt>","<model>","<effort>"].
# Reply: {"code":N,"out":"<base64 stdout>","err":"<base64 end of stderr>"}. Base64 so this never parses JSON.
dir=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d) || exit 1
cpid=
trap '[ -n "$cpid" ] && kill "$cpid" 2>/dev/null; rm -rf "$tmp"' EXIT
trap 'exit 1' INT TERM HUP
: > "$tmp/out"
: > "$tmp/err"
# Background jobs get /dev/null as stdin; keep Chrome's pipe on fd 3 for the watcher below.
exec 3<&0

reply() {
  msg="{\"code\":$1,\"out\":\"$(base64 < "$tmp/out" | tr -d '\n')\",\"err\":\"$(tail -c 2000 "$tmp/err" | base64 | tr -d '\n')\"}"
  n=${#msg}
  printf "$(printf '\\%03o\\%03o\\%03o\\%03o' $((n & 255)) $((n >> 8 & 255)) $((n >> 16 & 255)) $((n >> 24 & 255)))"
  printf %s "$msg"
}

len=$(dd bs=1 count=4 2>/dev/null | od -An -tu4 | tr -d ' \n')
[ -n "$len" ] || exit 1
head -c "$len" | tr -d '[]" ' > "$tmp/req"
IFS=, read -r sys prompt model effort < "$tmp/req"

# Only these reach the command line; everything else is fixed below (job pages are untrusted input).
for v in "$model" "$effort"; do
  case $v in
    *[!abcdefghijklmnopqrstuvwxyz0123456789.-]*) printf 'bad model or effort: %s' "$v" > "$tmp/err"; reply 2; exit 0 ;;
  esac
  [ ${#v} -le 32 ] || { printf 'bad model or effort' > "$tmp/err"; reply 2; exit 0; }
done

printf %s "$sys" | base64 --decode > "$tmp/sys"
printf %s "$prompt" | base64 --decode > "$tmp/in"
# No tools, MCP, hooks, plugins or CLAUDE.md; nothing saved to disk.
set -- -p --safe-mode --tools "" --strict-mcp-config --permission-mode dontAsk --max-turns 1 \
  --no-session-persistence --output-format stream-json --verbose "--system-prompt-file=$tmp/sys"
[ -n "$model" ] && set -- "$@" "--model=$model"
[ -n "$effort" ] && set -- "$@" "--effort=$effort"

cd "$dir" || exit 1
DISABLE_AUTOUPDATER=1 "$(cat "$dir/claude-path")" "$@" < "$tmp/in" > "$tmp/out" 2> "$tmp/err" &
cpid=$!
# Chrome closes stdin when the extension disconnects (aborted, timed out): stop claude then.
(cat > /dev/null; kill "$cpid" 2>/dev/null) <&3 > /dev/null 2>&1 &
wpid=$!
wait "$cpid"
code=$?
cpid=
kill "$wpid" 2>/dev/null
reply "$code"
