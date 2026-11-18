# purge-x · git 发布脚本（先登录一次，之后全自动）
#
# 前置：
#   git 已安装，且已通过 `git credential-manager github login` 完成一次授权
#   （授权后 token 存在 GCM 的凭据里，本脚本通过 `git credential fill` 取出来调 API）
#
# 用法：
#   pwsh -File scripts/git-publish.ps1                 # 建仓 + push
#   pwsh -File scripts/git-publish.ps1 -Tag v2.0.0     # 再打 tag 推上去（触发 release workflow）
#   pwsh -File scripts/git-publish.ps1 -Proxy http://127.0.0.1:7897
#
# 直连不通时用 -Proxy，或者先 `git config --global http.proxy`。

[CmdletBinding()]
param(
  [string]$Owner = "emperor016043-glitch",
  [string]$Repo  = "purge-x",
  [string]$Branch = "main",
  [string]$Proxy = "",
  [string]$Tag = "",
  [switch]$Private,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$api = "https://api.github.com"

# 新装 git 的机器上，当前进程的 PATH 常常还没刷新；先把常见安装位置补进来。
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  foreach ($cand in @(
    "D:\Program Files\Git\cmd\git.exe",
    "C:\Program Files\Git\cmd\git.exe",
    "C:\Program Files (x86)\Git\cmd\git.exe",
    "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
  )) {
    if (Test-Path $cand) {
      $env:Path = (Split-Path $cand) + ";" + $env:Path
      Write-Host "    [ok] git -> $cand" -ForegroundColor DarkGray
      break
    }
  }
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "找不到 git：装一个，或用 scripts/publish.ps1（REST API 路径，不需要 git）"
}

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "    [ok] $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "    [!!] $m" -ForegroundColor Yellow }

if ($Proxy) {
  $env:HTTPS_PROXY = $Proxy
  $env:HTTP_PROXY = $Proxy
  git config --global http.proxy $Proxy
  git config --global https.proxy $Proxy
  Write-Ok "proxy = $Proxy"
}

Push-Location $root
try {
  Write-Step "取 GCM 里的 GitHub token"
  $probe = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
  $token = ($probe | Where-Object { $_ -match '^password=' }) -replace '^password=', ''
  if (-not $token) {
    throw "拿不到 token：先跑一次 `git credential-manager github login` 完成授权，再重试"
  }
  Write-Ok "token 长度 $($token.Length)"

  $headers = @{
    Authorization          = "Bearer $token"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "purge-x-publish"
  }

  Write-Step "检查仓库 $Owner/$Repo"
  $exists = $true
  try {
    Invoke-RestMethod -Method GET -Uri "$api/repos/$Owner/$Repo" -Headers $headers | Out-Null
  } catch {
    $exists = $false
  }

  if (-not $exists) {
    Write-Step "创建仓库"
    $body = @{
      name        = $Repo
      description = "Cross-host instruction-authority plugin (WorkBuddy / CodeBuddy / Doubao). Multi-target rewrite of dsh-purge."
      private     = [bool]$Private
      has_issues  = $true
      has_wiki    = $false
      auto_init   = $false
    } | ConvertTo-Json
    $created = Invoke-RestMethod -Method POST -Uri "$api/user/repos" -Headers $headers -Body $body -ContentType "application/json"
    Write-Ok "已创建 $($created.html_url)"
  } else {
    Write-Ok "仓库已存在"
  }

  Write-Step "推送 $Branch"
  $remote = "https://github.com/$Owner/$Repo.git"
  $has = (git remote) -contains "origin"
  if ($has) { git remote set-url origin $remote } else { git remote add origin $remote }
  git -c user.name="emperor016043-glitch" -c user.email="emperor016043-glitch@users.noreply.github.com" add -A
  $pending = git status --porcelain
  if ($pending) {
    git -c user.name="emperor016043-glitch" -c user.email="emperor016043-glitch@users.noreply.github.com" commit -q -m "purge-x: update before publish"
    Write-Ok "补充提交"
  }
  git push -u origin $Branch 2>&1 | ForEach-Object { Write-Host "    $_" }
  if ($LASTEXITCODE -ne 0) { throw "push 失败（exit $LASTEXITCODE）" }
  Write-Ok "push 完成"

  if ($Tag) {
    Write-Step "打 tag $Tag"
    git tag -f $Tag 2>&1 | Out-Null
    git push -f origin $Tag 2>&1 | ForEach-Object { Write-Host "    $_" }
    Write-Ok "tag 已推送，release workflow 会开始打包"
  }

  Write-Host ""
  Write-Host "仓库：https://github.com/$Owner/$Repo" -ForegroundColor Cyan
  if ($Tag) { Write-Host "Release：https://github.com/$Owner/$Repo/releases/tag/$Tag" -ForegroundColor Cyan }
} finally {
  Pop-Location
}
