# AutoApply's Claude bridge (Windows): a Chrome native messaging host that runs the user's own `claude -p`
# once per launch. Request: ["<base64 system prompt>","<base64 prompt>","<model>","<effort>"].
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

# Only these reach the command line; everything else is fixed below (job pages are untrusted input).
foreach ($v in $req[2], $req[3]) {
  if ($v -cnotmatch '^[a-z0-9.-]{0,32}\z') { Send-Reply 2 '' "bad model or effort: $v"; exit 0 }
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('autoapply-' + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
$sys = Join-Path $tmp 'sys'
[IO.File]::WriteAllBytes($sys, [Convert]::FromBase64String($req[0]))

# No tools, MCP, hooks, plugins or CLAUDE.md; nothing saved to disk.
$argv = '-p --safe-mode --tools "" --strict-mcp-config --permission-mode dontAsk --max-turns 1 ' +
  '--no-session-persistence --output-format stream-json --verbose "--system-prompt-file=' + $sys + '"'
if ($req[2]) { $argv += ' --model=' + $req[2] }
if ($req[3]) { $argv += ' --effort=' + $req[3] }

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

try { $p = [Diagnostics.Process]::Start($psi) }
catch {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Send-Reply 127 '' $_.Exception.Message
  exit 0
}
$out = $p.StandardOutput.ReadToEndAsync()
$err = $p.StandardError.ReadToEndAsync()
# Raw UTF-8 bytes: a text writer would use the console code page and garble accented names.
$in = [Convert]::FromBase64String($req[1])
try { $p.StandardInput.BaseStream.Write($in, 0, $in.Length); $p.StandardInput.Close() } catch {}

# Chrome closes stdin when the extension disconnects (aborted, timed out): stop claude then.
$eof = $stdin.ReadAsync((New-Object byte[] 1), 0, 1)
while (-not $p.WaitForExit(200)) {
  if ($eof.IsCompleted) {
    # The whole tree: an npm install's claude.cmd runs node as a child.
    & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
  }
}
$p.WaitForExit()
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
Send-Reply $p.ExitCode $out.Result $err.Result
