#Requires -Version 5.1
<#
.SYNOPSIS
    把本扩展挂进 SillyTavern，便于「改完存盘 → 刷新酒馆」直接看到效果。

.DESCRIPTION
    用目录联接（junction）把本仓库链接到酒馆的
    <ST>\public\scripts\extensions\third-party\<扩展目录名>。
    联接不复制文件，改本仓库里的代码就等于改酒馆里加载的代码。
    没有酒馆源码目录、或不想用联接的，直接手工复制整个文件夹也可以。

.PARAMETER StPath
    酒馆安装目录，即含 package.json / config.yaml / public 的那层。

.PARAMETER Name
    在 third-party 下使用的目录名。必须和 manifest.json 无关但和 index.js 里的
    EXTENSION_PATH 保持一致，否则设置面板模板会 404。

.PARAMETER Remove
    只删除链接本身，不动本仓库里的任何文件。

.EXAMPLE
    .\install.ps1 -StPath 'D:\SillyTavern'

.EXAMPLE
    .\install.ps1 -StPath 'D:\SillyTavern' -Remove
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$StPath,

    [string]$Name = 'st-anko-director',

    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$extensionRoot = $PSScriptRoot
$stRoot = (Resolve-Path -LiteralPath $StPath).Path
$thirdParty = Join-Path $stRoot 'public\scripts\extensions\third-party'
$linkPath = Join-Path $thirdParty $Name

# 1) 先确认这真是酒馆目录，避免把链接建到莫名其妙的地方
if (-not (Test-Path -LiteralPath (Join-Path $stRoot 'package.json'))) {
    throw "在 '$stRoot' 里没找到 package.json，这看起来不是酒馆安装目录。"
}
if (-not (Test-Path -LiteralPath $thirdParty)) {
    throw "没有找到 '$thirdParty'，请确认酒馆版本里存在 public\scripts\extensions\third-party。"
}

Write-Host "扩展仓库 : $extensionRoot"
Write-Host "酒馆目录 : $stRoot"
Write-Host "链接位置 : $linkPath"
Write-Host ''

if ($Remove) {
    if (-not (Test-Path -LiteralPath $linkPath)) {
        Write-Host '链接不存在，无需处理。'
        return
    }

    $item = Get-Item -LiteralPath $linkPath -Force
    if ($item.LinkType -ne 'Junction') {
        throw "'$linkPath' 不是本脚本创建的联接（LinkType=$($item.LinkType)），已停止，请手工确认后再删。"
    }
    if ($item.Target -and ($item.Target | Select-Object -First 1) -ne $extensionRoot) {
        throw "'$linkPath' 指向的是 '$($item.Target)'，不是本仓库 '$extensionRoot'，已停止。"
    }

    # rmdir 只摘掉联接本身，不会进到里面删文件
    & cmd /c rmdir "$linkPath"
    if ($LASTEXITCODE -ne 0) {
        throw "删除链接失败（rmdir 退出码 $LASTEXITCODE）。"
    }
    Write-Host '链接已删除，本仓库文件未受影响。'
    return
}

if (Test-Path -LiteralPath $linkPath) {
    Write-Host "'$linkPath' 已存在，跳过创建。若指向的不是本仓库，请先执行 -Remove。"
    return
}

# 2) 建联接。junction 不需要管理员权限，也不需要开发者模式。
New-Item -ItemType Junction -Path $linkPath -Target $extensionRoot | Out-Null

# 3) 校验一下真的能读到 manifest.json
$manifestPath = Join-Path $linkPath 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "链接建好了，但通过它读不到 manifest.json（$manifestPath），请检查目录结构。"
}

Write-Host '完成。接下来：'
Write-Host '  1. 刷新酒馆页面（必要时重启酒馆进程）。'
Write-Host '  2. 打开「扩展」面板，确认列表里出现本扩展并且是启用状态。'
Write-Host '  3. 改代码后刷新页面即可生效；只改 i18n/*.json 也需要刷新。'
Write-Host ''
Write-Host "卸载：.\install.ps1 -StPath '$stRoot' -Name '$Name' -Remove"
