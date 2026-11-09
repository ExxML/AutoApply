# AutoApply's Claude bridge (Windows): a Chrome native messaging host that runs the user's own `claude -p`
# once per launch. Request: ["<base64 system prompt>","<base64 prompt>","<model>","<effort>"]; a model of "?models"
# lists the models instead (older bridges refuse it as a bad model).
# Reply: {"code":N,"out":"<base64 stdout>","err":"<base64 end of stderr>"}. ASCII only: PowerShell 5.1 reads it as ANSI.
$ErrorActionPreference = 'Stop'
$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Read-Exactly([int]$n) {
  $buf = New-Object byte[] $n
  $got = 0
  while ($got -lt $n) {
    $r = $stdin.Read($buf, $got, $n - $got)
    if ($r -le 0) { exit 1 }
    $got += $r
  }
  , $buf
}

function Send-Reply([int]$code, [string]$out, [string]$err) {
  if ($err.Length -gt 2000) { $err = $err.Substring($err.Length - 2000) }
  $b64 = { param($s) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }
  $msg = [Text.Encoding]::ASCII.GetBytes('{"code":' + $code + ',"out":"' + (& $b64 $out) + '","err":"' + (& $b64 $err) + '"}')
  $stdout.Write([BitConverter]::GetBytes($msg.Length), 0, 4)
  $stdout.Write($msg, 0, $msg.Length)
  $stdout.Flush()
}

$len = [BitConverter]::ToInt32((Read-Exactly 4), 0)
$req = [Text.Encoding]::UTF8.GetString((Read-Exactly $len)) | ConvertFrom-Json

$list = $req[2] -ceq '?models'
# Only these reach the command line; everything else is fixed below (job pages are untrusted input).
if (-not $list) {
  foreach ($v in $req[2], $req[3]) {
    if ($v -cnotmatch '^[a-z0-9.-]{0,32}\z') { Send-Reply 2 '' "bad model or effort: $v"; exit 0 }
  }
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('autoapply-' + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null

# No tools, MCP, hooks, plugins or CLAUDE.md; nothing saved to disk.
$argv = '-p --safe-mode --tools "" --strict-mcp-config --permission-mode dontAsk --max-turns 1 ' +
  '--no-session-persistence --output-format stream-json --verbose'
if ($list) {
  # Claude Code's initialize reply lists the models this sign-in can use; no prompt is sent.
  $argv += ' --input-format stream-json'
  $in = [Text.Encoding]::ASCII.GetBytes('{"type":"control_request","request_id":"models","request":{"subtype":"initialize"}}' + "`n")
} else {
  $sys = Join-Path $tmp 'sys'
  [IO.File]::WriteAllBytes($sys, [Convert]::FromBase64String($req[0]))
  $argv += ' "--system-prompt-file=' + $sys + '"'
  if ($req[2]) { $argv += ' --model=' + $req[2] }
  if ($req[3]) { $argv += ' --effort=' + $req[3] }
  # Raw UTF-8 bytes: a text writer would use the console code page and garble accented names.
  $in = [Convert]::FromBase64String($req[1])
}

$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'claude-path.txt')).Trim()
$psi.Arguments = $argv
$psi.WorkingDirectory = $PSScriptRoot
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = [Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [Text.Encoding]::UTF8
$psi.EnvironmentVariables['DISABLE_AUTOUPDATER'] = '1'
# The system prompt (the same in every call) keeps Claude Code's hour-long cache; each call's own message is written to
# the 5-minute one, which costs less of the plan's limits.
$psi.EnvironmentVariables['CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL'] = '5m'

try { $p = [Diagnostics.Process]::Start($psi) }
catch {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Send-Reply 127 '' $_.Exception.Message
  exit 0
}
$out = New-Object Text.StringBuilder
$line = $p.StandardOutput.ReadLineAsync()
$err = $p.StandardError.ReadToEndAsync()
try { $p.StandardInput.BaseStream.Write($in, 0, $in.Length); $p.StandardInput.Close() } catch {}

# Chrome closes stdin when the extension disconnects (aborted, timed out): stop claude then.
$eof = $stdin.ReadAsync((New-Object byte[] 1), 0, 1)
$result = $false
while ($true) {
  if ($line.Wait(200)) {
    if ($null -eq $line.Result) { break }
    [void]$out.Append($line.Result).Append("`n")
    # The result line is the whole answer: replying then saves the half second claude takes to shut down.
    if ($line.Result.Contains('"type":"result"')) { $result = $true; break }
    $line = $p.StandardOutput.ReadLineAsync()
  } elseif ($eof.IsCompleted) {
    # The whole tree: an npm install's claude.cmd runs node as a child.
    & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
  }
}
if ($result) { Send-Reply 0 $out.ToString() '' }
else {
  $p.WaitForExit()
  Send-Reply $p.ExitCode $out.ToString() $err.Result
}
# Not killed: claude finishes saving its own state.
$p.WaitForExit(15000) | Out-Null
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
