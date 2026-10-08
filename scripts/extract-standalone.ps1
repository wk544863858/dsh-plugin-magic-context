# Rebuild `packages/dsh-plugin` as a standalone repository, preserving each commit's
# author, author date, committer, message and order, with the plugin at the repo root.
#
# This is the first step of publishing the adapter as its own project: the local
# branch is a fork of upstream, but the adapter's history must stand alone when it
# gets its own remote. Everything it writes stays under `<repo>/<tmp>`
# (ignored by the repo's `.tmp-*/` rule), so a trial run never touches tracked files.
#
# Why pure plumbing: `git subtree` and `git filter-branch` are POSIX shell scripts and
# cannot start a shell under the DSH sandbox (`git filter-repo` is not installed), so
# the replay archives each commit's subtree and re-commits it.
#
# Usage:
#   pwsh -File packages/dsh-plugin/scripts/extract-standalone.ps1 [-Branch dsh] [-Dest <dir>]
#   # then, once the run reports the expected commit count:
#   git -C <repo>/<tmp>/repo remote add origin <your-repo-url>
#   git -C <repo>/<tmp>/repo push -u origin main
#
# Verified 2026-10-08 on 42 commits of `packages/dsh-plugin`: the result carried the
# plugin at its root (81 files, no `packages/dsh-plugin/` prefix), the original
# authors and dates, and an empty `git status`.

[CmdletBinding()]
param(
  [string]$Branch = 'dsh',
  [string]$Dest
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# <repo>/packages/dsh-plugin/scripts -> <repo>
$Parent = (Resolve-Path -LiteralPath (Join-Path $ScriptDir '..\..\..')).Path
$Prefix = 'packages/dsh-plugin'
$TmpRoot = Join-Path $Parent '<tmp>'
if (-not $Dest) { $Dest = Join-Path $TmpRoot 'repo' }

# --- guards: never operate on a computed path we have not pinned ---------------
if (-not (Test-Path -LiteralPath (Join-Path $Parent '.git'))) { throw "parent repo not found: $Parent" }
# The destructive step is `Remove-Item -Recurse` on $Dest: require it under the
# scratch root so a typo can never delete a worktree.
if (-not $Dest.StartsWith($TmpRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "refusing to run: destination must stay under $TmpRoot (got $Dest)"
}
if (-not (Test-Path -LiteralPath $TmpRoot)) { New-Item -ItemType Directory -Path $TmpRoot -Force | Out-Null }

$tarball = Join-Path $TmpRoot 'subtree.tar'
$msgFile = Join-Path $TmpRoot 'commit-msg.txt'

# --- fresh destination --------------------------------------------------------
if (Test-Path -LiteralPath $Dest) {
  if ((Resolve-Path -LiteralPath $Dest).Path -ne $Dest) { throw "refusing to delete: $Dest" }
  Remove-Item -LiteralPath $Dest -Recurse -Force
}
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
git -C $Dest init -b main --quiet
if ($LASTEXITCODE -ne 0) { throw 'git init failed' }

$shas = git -C $Parent rev-list --reverse --no-merges "$Branch" -- $Prefix
if ($LASTEXITCODE -ne 0) { throw 'rev-list failed' }
Write-Host "replaying $($shas.Count) commits from $Branch"

$n = 0
foreach ($sha in $shas) {
  $n++

  # metadata
  $meta = git -C $Parent log -1 --format='%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI' $sha
  $f = $meta -split [char]0x1f
  if ($f.Count -lt 6) { throw "bad metadata for $sha" }
  $an, $ae, $ad, $cn, $ce, $cd = $f

  git -C $Parent log -1 --format=%B $sha | Set-Content -LiteralPath $msgFile -Encoding utf8NoBOM

  # wipe the worktree, keep .git
  Get-ChildItem -LiteralPath $Dest -Force | Where-Object { $_.Name -ne '.git' } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }

  # does this commit even contain the subtree?
  git -C $Parent cat-file -e "${sha}:$Prefix" 2>$null
  $hasTree = ($LASTEXITCODE -eq 0)
  if ($hasTree) {
    if (Test-Path -LiteralPath $tarball) { Remove-Item -LiteralPath $tarball -Force }
    git -C $Parent archive --format=tar -o $tarball $sha -- $Prefix
    if ($LASTEXITCODE -ne 0) { throw "archive failed for $sha" }
    tar -xf $tarball -C $Dest --strip-components=2
    if ($LASTEXITCODE -ne 0) { throw "tar failed for $sha" }
  }

  git -C $Dest add -A
  if ($LASTEXITCODE -ne 0) { throw "add failed for $sha" }

  $env:GIT_AUTHOR_NAME = $an
  $env:GIT_AUTHOR_EMAIL = $ae
  $env:GIT_AUTHOR_DATE = $ad
  $env:GIT_COMMITTER_NAME = $cn
  $env:GIT_COMMITTER_EMAIL = $ce
  $env:GIT_COMMITTER_DATE = $cd

  git -C $Dest commit --quiet --allow-empty -F $msgFile
  if ($LASTEXITCODE -ne 0) { throw "commit failed for $sha ($n/$($shas.Count))" }

  if ($n % 10 -eq 0) { Write-Host "  $n/$($shas.Count)" }
}

Remove-Item Env:GIT_AUTHOR_NAME, Env:GIT_AUTHOR_EMAIL, Env:GIT_AUTHOR_DATE,
  Env:GIT_COMMITTER_NAME, Env:GIT_COMMITTER_EMAIL, Env:GIT_COMMITTER_DATE -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $tarball, $msgFile -Force -ErrorAction SilentlyContinue

Write-Host "`n=== result ==="
git -C $Dest log --oneline | Measure-Object | Select-Object -ExpandProperty Count | ForEach-Object { "commits=$_" }
git -C $Dest log --oneline -3
"--- root ---"
Get-ChildItem -LiteralPath $Dest -Force | Select-Object -ExpandProperty Name
