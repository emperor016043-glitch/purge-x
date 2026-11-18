# purge-x · GitHub 发布脚本（无 git 依赖，走 REST Contents API）
#
# 用法：
#   $env:GITHUB_TOKEN = "ghp_xxx"
#   pwsh -File scripts/publish.ps1
#
#   pwsh -File scripts/publish.ps1 -DryRun          # 只打印计划，不调 API
#   pwsh -File scripts/publish.ps1 -Repo purge-x -Private
#
# token 权限只需要 classic PAT 的 `repo`（或 fine-grained 的 Contents: RW + Administration: R）。
# 已存在的文件会覆盖（先 GET 取 sha 再 PUT），不会重复建仓。

[CmdletBinding()]
param(
  [string]$Owner = "emperor016043-glitch",
  [string]$Repo  = "purge-x",
  [string]$Token = $env:GITHUB_TOKEN,
  [string]$Branch = "main",
  [string]$Message = "purge-x 2.0.0: cross-host instruction-authority plugin (workbuddy + doubao)",
  [switch]$Private,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$api  = "https://api.github.com"

$excludeDirs = @(".git", "node_modules", "dist", "coverage", "_probe", ".purge-x")
$excludeExt  = @(".log", ".tgz", ".zip")

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    [!!] $msg" -ForegroundColor Yellow }

function Get-RepoFiles {
  $out = @()
  $stack = [System.Collections.Generic.Stack[string]]::new()
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    foreach ($entry in Get-ChildItem -LiteralPath $dir -Force) {
      if ($entry.PSIsContainer) {
        if ($excludeDirs -contains $entry.Name) { continue }
        $stack.Push($entry.FullName)
        continue
      }
      if ($excludeExt -contains $entry.Extension) { continue }
      $rel = $entry.FullName.Substring($root.Length).TrimStart('\', '/') -replace '\\', '/'
      if ($rel -match '(^|/)\.purge-x-wtest-') { continue }
      $out += [pscustomobject]@{ Path = $rel; Full = $entry.FullName; Size = $entry.Length }
    }
  }
  return $out | Sort-Object Path
}

function Invoke-Gh {
  param(
    [string]$Method,
    [string]$Uri,
    $Body = $null
  )
  $headers = @{
    Authorization          = "Bearer $Token"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "purge-x-publish"
  }
  $req = @{ Method = $Method; Uri = $Uri; Headers = $headers; ErrorAction = "Stop" }
  if ($null -ne $Body) {
    $req.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
    $req.ContentType = "application/json; charset=utf-8"
  }
  return Invoke-RestMethod @req
}

$files = Get-RepoFiles
Write-Step "待发布 $($files.Count) 个文件，目标 $Owner/$Repo ($Branch)"
foreach ($f in $files) { Write-Host ("      {0,8}  {1}" -f $f.Size, $f.Path) }

if ($DryRun) {
  Write-Warn2 "-DryRun：没有调用 GitHub API"
  return
}

if (-not $Token) {
  throw "缺少 token：设置 `$env:GITHUB_TOKEN 或用 -Token 传入"
}

try {
  $me = Invoke-Gh -Method GET -Uri "$api/user"
  Write-Ok "token 有效，身份 $($me.login)"
} catch {
  throw "token 校验失败：$($_.Exception.Message)"
}

$repoUri = "$api/repos/$Owner/$Repo"
$exists = $true
try { Invoke-Gh -Method GET -Uri $repoUri | Out-Null } catch { $exists = $false }

if (-not $exists) {
  Write-Step "创建仓库 $Owner/$Repo"
  $payload = @{
    name        = $Repo
    description = "Cross-host instruction-authority plugin (WorkBuddy / CodeBuddy / Doubao). Multi-target rewrite of dsh-purge."
    private     = [bool]$Private
    has_issues  = $true
    has_wiki    = $false
    auto_init   = $false
  }
  $created = Invoke-Gh -Method POST -Uri "$api/user/repos" -Body $payload
  Write-Ok "已创建 $($created.html_url)"
} else {
  Write-Ok "仓库已存在，走更新流程"
}

$uploaded = 0
$skipped  = 0
foreach ($f in $files) {
  $encodedPath = ($f.Path -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
  $uri = "$repoUri/contents/$encodedPath"

  $sha = $null
  try {
    $meta = Invoke-Gh -Method GET -Uri "$uri`?ref=$Branch"
    $sha = $meta.sha
  } catch {
    $sha = $null
  }

  $bytes = [System.IO.File]::ReadAllBytes($f.Full)
  $payload = @{
    message = "$Message"
    content = [Convert]::ToBase64String($bytes)
    branch  = $Branch
  }
  if ($sha) { $payload.sha = $sha }

  try {
    Invoke-Gh -Method PUT -Uri $uri -Body $payload | Out-Null
    $uploaded++
    Write-Host "    [up] $($f.Path)"
  } catch {
    $skipped++
    Write-Warn2 "失败 $($f.Path): $($_.Exception.Message)"
  }
}

Write-Host ""
Write-Host "完成：$uploaded 成功 / $skipped 失败" -ForegroundColor Green
Write-Host "仓库地址：https://github.com/$Owner/$Repo" -ForegroundColor Cyan
Write-Host "下一步：去 Releases 打 tag v2.0.0，或直接 push（.github/workflows/release.yml 会自动打包）" -ForegroundColor DarkGray
