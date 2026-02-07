param(
    [switch]$NoPrompt,
    [switch]$NoOnboard,
    [switch]$DryRun,
    [switch]$Verbose,
    [switch]$NoRun
)

$ErrorActionPreference = "Stop"

$PackageName = if ($env:KEYGATE_NPM_PACKAGE) { $env:KEYGATE_NPM_PACKAGE } else { "@keygate/cli" }
$PackageVersion = if ($env:KEYGATE_VERSION) { $env:KEYGATE_VERSION } else { "latest" }
$ConfigDir = "$env:USERPROFILE\.config\keygate"
$WorkspaceDir = "$env:USERPROFILE\keygate-workspace"
$OriginalPath = $env:Path
$IsWindowsPlatform = $env:OS -eq 'Windows_NT'
$script:KeygateCommand = ""

if ($NoPrompt) {
    $NoRun = $true
}

if ($Verbose) {
    $VerbosePreference = "Continue"
}

function Write-Info($Message) { Write-Host "i $Message" -ForegroundColor Cyan }
function Write-Ok($Message) { Write-Host "✓ $Message" -ForegroundColor Green }
function Write-WarnMsg($Message) { Write-Host "! $Message" -ForegroundColor Yellow }
function Write-ErrMsg($Message) { Write-Host "x $Message" -ForegroundColor Red }

function Is-Promptable {
    if ($NoPrompt) { return $false }
    try {
        if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
            return $false
        }
        return $true
    } catch {
        return $false
    }
}

function Invoke-Step {
    param(
        [scriptblock]$Action,
        [string]$DryRunMessage
    )

    if ($DryRun) {
        if ($DryRunMessage) {
            Write-Host "[dry-run] $DryRunMessage" -ForegroundColor DarkGray
        }
        return
    }

    & $Action
}

function Prompt-Text {
    param(
        [string]$Prompt,
        [string]$Default = ""
    )

    if (-not (Is-Promptable)) {
        return $Default
    }

    if ($Default) {
        $input = Read-Host "$Prompt [$Default]"
    } else {
        $input = Read-Host $Prompt
    }

    if ([string]::IsNullOrWhiteSpace($input)) {
        return $Default
    }

    return $input
}

function Prompt-YesNo {
    param(
        [string]$Prompt,
        [bool]$DefaultYes = $true
    )

    if (-not (Is-Promptable)) {
        return $DefaultYes
    }

    $suffix = if ($DefaultYes) { "[Y/n]" } else { "[y/N]" }
    $input = Read-Host "$Prompt $suffix"

    if ([string]::IsNullOrWhiteSpace($input)) {
        return $DefaultYes
    }

    return $input -match '^[Yy]$'
}

function Prompt-Secret {
    param([string]$Prompt)

    if (-not (Is-Promptable)) {
        return ""
    }

    $secure = Read-Host $Prompt -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    } finally {
        if ($bstr -ne [IntPtr]::Zero) {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }
}

function Test-Prerequisites {
    Write-Host "Keygate installer" -ForegroundColor Magenta

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-ErrMsg "Node.js is required (v22+)."
        exit 1
    }

    $nodeVersion = (node -v) -replace '^v', ''
    $major = [int]($nodeVersion.Split('.')[0])
    if ($major -lt 22) {
        Write-ErrMsg "Node.js v$nodeVersion detected. Node.js v22+ is required."
        exit 1
    }
    Write-Ok "Node.js v$nodeVersion found"

    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-ErrMsg "npm is required."
        exit 1
    }
    Write-Ok "npm $(npm -v) found"
}

function Get-NpmGlobalBin {
    try {
        $prefix = (npm prefix -g).Trim()
        if (-not $prefix) { return "" }
        return $prefix
    } catch {
        return ""
    }
}

function Resolve-KeygateCommand {
    $cmd = Get-Command keygate -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }

    $binDir = Get-NpmGlobalBin
    if ($binDir) {
        $candidate = if ($IsWindowsPlatform) {
            Join-Path $binDir "keygate.cmd"
        } else {
            Join-Path $binDir "keygate"
        }

        if (Test-Path $candidate) {
            return $candidate
        }
    }

    return ""
}

function Warn-IfPathMissing {
    $binDir = Get-NpmGlobalBin
    if (-not $binDir) { return }

    $segments = $OriginalPath -split ';' | ForEach-Object { $_.Trim() }
    if ($segments -contains $binDir) { return }

    Write-WarnMsg "PATH may not include npm global bin: $binDir"
    Write-Host "Add this to your user PATH if 'keygate' is not found: $binDir"
}

function Install-KeygateGlobal {
    $spec = "$PackageName@$PackageVersion"
    Write-Info "Installing $spec globally via npm"

    if ($DryRun) {
        Write-Host "[dry-run] npm install -g $spec" -ForegroundColor DarkGray
        $script:KeygateCommand = "keygate"
        return
    }

    try {
        npm --no-fund --no-audit install -g $spec
    } catch {
        Write-WarnMsg "Initial npm install failed. Retrying once..."
        npm --no-fund --no-audit install -g $spec
    }

    $script:KeygateCommand = Resolve-KeygateCommand
    if (-not $script:KeygateCommand) {
        Warn-IfPathMissing
        Write-ErrMsg "Installation completed but 'keygate' is not discoverable on PATH."
        exit 1
    }

    Write-Ok "Installed keygate binary at: $script:KeygateCommand"
}

function Run-CodexLogin {
    if (-not (Is-Promptable)) {
        return $false
    }

    Write-Info "Starting Codex login now..."

    try {
        & $script:KeygateCommand auth login --provider openai-codex
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "Codex login completed"
            return $true
        }
    } catch {
        # handled below
    }

    Write-WarnMsg "Codex login failed or was cancelled."
    return $false
}

function Write-Config {
    param(
        [string]$Provider,
        [string]$Model,
        [string]$ApiKey,
        [string]$OllamaHost,
        [string]$SpicyModeEnabled
    )

    Write-Info "Writing configuration files to $ConfigDir"

    Invoke-Step -Action {
        New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
        New-Item -ItemType Directory -Force -Path $WorkspaceDir | Out-Null
    } -DryRunMessage "Create config/workspace directories"

    if ($DryRun) {
        return
    }

    $envLines = @(
        "LLM_PROVIDER=$Provider",
        "LLM_MODEL=$Model",
        "LLM_API_KEY=$ApiKey",
        "LLM_OLLAMA_HOST=$OllamaHost",
        "SPICY_MODE_ENABLED=$SpicyModeEnabled",
        "WORKSPACE_PATH=$WorkspaceDir",
        "PORT=18790"
    )

    Set-Content -Path "$ConfigDir\.env" -Value ($envLines -join "`n") -NoNewline

    $config = [ordered]@{
        llm = [ordered]@{
            provider = $Provider
            model = $Model
        }
        security = [ordered]@{
            spicyModeEnabled = [bool]::Parse($SpicyModeEnabled)
            workspacePath = $WorkspaceDir
            allowedBinaries = @("git", "ls", "npm", "cat", "node", "python3")
        }
        server = [ordered]@{
            port = 18790
        }
    }

    $configJson = $config | ConvertTo-Json -Depth 8
    Set-Content -Path "$ConfigDir\config.json" -Value $configJson

    Write-Ok "Configuration saved"
}

function Run-Onboarding {
    $provider = "openai"
    $model = "gpt-4o"
    $apiKey = ""
    $ollamaHost = ""
    $spicyModeEnabled = "false"

    if ($NoOnboard) {
        Write-Info "Skipping onboarding (-NoOnboard)."
        Write-Config -Provider $provider -Model $model -ApiKey $apiKey -OllamaHost $ollamaHost -SpicyModeEnabled $spicyModeEnabled
        return
    }

    if (-not (Is-Promptable)) {
        Write-WarnMsg "No interactive TTY detected. Applying deterministic defaults."
        Write-Config -Provider $provider -Model $model -ApiKey $apiKey -OllamaHost $ollamaHost -SpicyModeEnabled $spicyModeEnabled
        return
    }

    Write-Host ""
    Write-Host "Keygate can execute commands on your machine."
    if (-not (Prompt-YesNo -Prompt "Continue with setup?" -DefaultYes $true)) {
        Write-WarnMsg "Installer aborted by user."
        exit 0
    }

    $riskAck = Prompt-Text -Prompt "Type I ACCEPT THE RISK to enable Spicy Mode (or press Enter for Safe Mode)"
    if ($riskAck -eq "I ACCEPT THE RISK") {
        $spicyModeEnabled = "true"
        Write-WarnMsg "Spicy Mode enabled"
    } else {
        $spicyModeEnabled = "false"
        Write-Ok "Safe Mode enabled"
    }

    while ($true) {
        Write-Host ""
        Write-Host "Choose provider:"
        Write-Host "  1) OpenAI"
        Write-Host "  2) OpenAI Codex (ChatGPT OAuth)"
        Write-Host "  3) Google Gemini"
        Write-Host "  4) Ollama"
        Write-Host "  5) Skip for now"

        $choice = Prompt-Text -Prompt "Enter choice" -Default "2"

        switch ($choice) {
            "1" {
                $provider = "openai"
                $model = Prompt-Text -Prompt "OpenAI model" -Default "gpt-4o"
                $apiKey = Prompt-Secret -Prompt "OpenAI API key"
                $ollamaHost = ""
                break
            }
            "2" {
                $provider = "openai-codex"
                $model = Prompt-Text -Prompt "Codex model" -Default "openai-codex/gpt-5.3"
                $apiKey = ""
                $ollamaHost = ""
                if (Run-CodexLogin) {
                    break
                }
                Write-Info "Returning to provider selection..."
                continue
            }
            "3" {
                $provider = "gemini"
                $model = Prompt-Text -Prompt "Gemini model" -Default "gemini-1.5-pro"
                $apiKey = Prompt-Secret -Prompt "Gemini API key"
                $ollamaHost = ""
                break
            }
            "4" {
                $provider = "ollama"
                $model = Prompt-Text -Prompt "Ollama model" -Default "llama3"
                $ollamaHost = Prompt-Text -Prompt "Ollama host" -Default "http://127.0.0.1:11434"
                $apiKey = ""
                break
            }
            "5" {
                $provider = "openai"
                $model = "gpt-4o"
                $apiKey = ""
                $ollamaHost = ""
                break
            }
            default {
                Write-WarnMsg "Invalid choice."
                continue
            }
        }

        break
    }

    Write-Config -Provider $provider -Model $model -ApiKey $apiKey -OllamaHost $ollamaHost -SpicyModeEnabled $spicyModeEnabled
}

function Finish-AndMaybeRun {
    $chatUrl = if ($env:KEYGATE_CHAT_URL) { $env:KEYGATE_CHAT_URL } else { "http://localhost:18790" }

    Write-Host ""
    Write-Ok "Keygate installed successfully"
    Write-Host "Command: keygate"
    Write-Host "Chat URL: $chatUrl"

    $canPrompt = Is-Promptable
    if ($NoRun -or $NoPrompt -or -not $canPrompt) {
        Write-Host ""
        Write-Host "Run manually when ready:"
        Write-Host "  keygate"
        Write-Host "Then open: $chatUrl"
        return
    }

    if (Prompt-YesNo -Prompt "Run the Keygate web app now?" -DefaultYes $true) {
        if ($DryRun) {
            Write-Host "[dry-run] Start-Process $chatUrl" -ForegroundColor DarkGray
            Write-Host "[dry-run] $script:KeygateCommand" -ForegroundColor DarkGray
            return
        }

        try {
            Start-Process $chatUrl | Out-Null
        } catch {
            Write-WarnMsg "Unable to open browser automatically."
        }

        & $script:KeygateCommand
        return
    }

    Write-Host ""
    Write-Host "Run manually when ready:"
    Write-Host "  keygate"
    Write-Host "Then open: $chatUrl"
}

Test-Prerequisites
Install-KeygateGlobal
Warn-IfPathMissing
Run-Onboarding
Finish-AndMaybeRun
