# Keygate Installer for Windows
# Run with: powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"

# Config paths
$ConfigDir = "$env:USERPROFILE\.config\keygate"
$DefaultInstallDir = "$env:LOCALAPPDATA\keygate"
$BinDir = "$env:USERPROFILE\keygate-bin"

function Write-ColorOutput($Text, $Color) {
    try {
        Write-Host $Text -ForegroundColor $Color
    } catch {
        Write-Host $Text
    }
}

function Show-Spinner {
    param([int]$ProcessingId)
    $spinChars = @('|', '/', '-', '\')
    while (Get-Process -Id $ProcessingId -ErrorAction SilentlyContinue) {
        foreach ($char in $spinChars) {
            Write-Host -NoNewline "`r [$char]  "
            Start-Sleep -Milliseconds 100
        }
    }
    Write-Host "`r      "
}

Clear-Host

Write-ColorOutput "╔═══════════════════════════════════════════════════════════════╗" "Magenta"
Write-ColorOutput "║                                                               ║" "Magenta"
Write-ColorOutput "║   ⚡ KEYGATE INSTALLER                                        ║" "Magenta"
Write-ColorOutput "║   Personal AI Agent Gateway                                   ║" "Magenta"
Write-ColorOutput "║                                                               ║" "Magenta"
Write-ColorOutput "╚═══════════════════════════════════════════════════════════════╝" "Magenta"
Write-Host ""

Write-ColorOutput "Welcome to the Keygate setup wizard!" "Cyan"
Write-Host "This script will install Keygate and configure your environment."
Write-Host ""
Read-Host "Press Enter to continue..."
Write-Host ""

# =============================================
# PREREQUISITE CHECK
# =============================================

Write-ColorOutput "Step 1: Checking Prerequisites..." "Cyan"

if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-ColorOutput "✓ git found" "Green"
} else {
    Write-ColorOutput "❌ git is not installed. Please install git first." "Red"
    exit 1
}

if (Get-Command node -ErrorAction SilentlyContinue) {
    $NodeVersion = (node -v) -replace 'v', ''
    $MajorVersion = [int]($NodeVersion.Split('.')[0])
    
    if ($MajorVersion -ge 22) {
        Write-ColorOutput "✓ Node.js v$NodeVersion found" "Green"
    } else {
        Write-ColorOutput "⚠️  Warning: Node.js version $NodeVersion detected. Keygate requires Node.js 22+" "Yellow"
        $ContinueNode = Read-Host "Continue anyway? [y/N]"
        if ($ContinueNode -notmatch "^[Yy]$") { exit 1 }
    }
} else {
    Write-ColorOutput "❌ Node.js is not installed. Please install Node.js 22+ first." "Red"
    exit 1
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-ColorOutput "⚠️  pnpm not found. Installing pnpm via corepack..." "Yellow"
    cmd /c "corepack enable"
    cmd /c "corepack prepare pnpm@latest --activate"
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        Write-ColorOutput "❌ Failed to install pnpm automatically. Please run: npm install -g pnpm" "Red"
        exit 1
    }
}
Write-ColorOutput "✓ pnpm $((pnpm -v)) found" "Green"

# =============================================
# INSTALL LOCATION
# =============================================

Write-Host ""
Write-ColorOutput "Step 2: Installation Location" "Cyan"

if (Test-Path "package.json") {
    $CurrentDir = Get-Location
    if (Select-String -Path "package.json" -Pattern "keygate" -Quiet) {
        Write-Host "Detected running inside Keygate repository at: $CurrentDir" -ForegroundColor Yellow
        $InstallHere = Read-Host "Install here? [Y/n]"
        if ($InstallHere -eq "" -or $InstallHere -match "^[Yy]$") {
            $InstallDir = $CurrentDir
        } else {
            $InstallDir = Read-Host "Enter installation path [$DefaultInstallDir]"
            if ([string]::IsNullOrEmpty($InstallDir)) { $InstallDir = $DefaultInstallDir }
        }
    } else {
        $InstallDir = Read-Host "Enter installation path [$DefaultInstallDir]"
        if ([string]::IsNullOrEmpty($InstallDir)) { $InstallDir = $DefaultInstallDir }
    }
} else {
    $InstallDir = Read-Host "Enter installation path [$DefaultInstallDir]"
    if ([string]::IsNullOrEmpty($InstallDir)) { $InstallDir = $DefaultInstallDir }
}

$WorkspaceDir = "$env:USERPROFILE\keygate-workspace"
Write-Host "Keygate Workspace will be created at: $WorkspaceDir" -ForegroundColor Yellow

# =============================================
# SAFETY DISCLAIMER
# =============================================

Write-Host ""
Write-ColorOutput "Step 3: Security Configuration" "Cyan"
Write-ColorOutput "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" "Yellow"
Write-ColorOutput "⚠️  IMPORTANT SAFETY DISCLAIMER" "Red"
Write-ColorOutput "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" "Yellow"
Write-Host ""
Write-Host "Keygate is an AI agent that can execute commands on your computer."
Write-Host ""
Write-ColorOutput "SAFE MODE (Default):" "Green"
Write-Host "  • File operations restricted to $WorkspaceDir"
Write-Host "  • Only allowed commands: git, ls, npm, cat, node, python3"
Write-Host "  • All write/execute actions require your confirmation"
Write-Host ""
Write-ColorOutput "SPICY MODE (Dangerous):" "Red"
Write-Host "  • FULL access to your entire filesystem"
Write-Host "  • Can run ANY command without restrictions"
Write-Host "  • NO confirmation prompts - autonomous execution"
Write-Host ""
Write-ColorOutput "Spicy Mode should ONLY be used in sandboxed/VM environments." "Red"
Write-Host ""
Write-Host "To " -NoNewline
Write-ColorOutput "enable Spicy Mode" "Red" -NoNewline
Write-Host ", type exactly: " -NoNewline
Write-ColorOutput "I ACCEPT THE RISK" "Yellow"
Write-Host "To continue with Safe Mode only, press Enter."
Write-Host ""

$RiskInput = Read-Host "> "
$SpicyEnabled = "false"

if ($RiskInput -eq "I ACCEPT THE RISK") {
    $SpicyEnabled = "true"
    Write-Host ""
    Write-ColorOutput "⚠️  SPICY MODE ENABLED - You have been warned!" "Red"
} else {
    Write-Host ""
    Write-ColorOutput "✓ Safe Mode only - Good choice!" "Green"
}

# =============================================
# LLM CONFIGURATION
# =============================================

Write-Host ""
Write-ColorOutput "Step 4: AI Model Configuration" "Cyan"

Write-Host "Select your LLM provider:"
Write-Host "  1) OpenAI (gpt-4o, gpt-4-turbo, etc.)"
Write-Host "  2) Google Gemini (gemini-1.5-pro, gemini-1.5-flash, etc.)"
Write-Host "  3) local Ollama (llama3, mistral, deepseek-r1, etc.)"
Write-Host ""

$ProviderChoice = Read-Host "Enter choice [1/2/3]"

switch ($ProviderChoice) {
    "2" {
        $LLMProvider = "gemini"
        $DefaultModel = "gemini-1.5-pro"
    }
    "3" {
        $LLMProvider = "ollama"
        $DefaultModel = "llama3"
    }
    default {
        $LLMProvider = "openai"
        $DefaultModel = "gpt-4o"
    }
}

Write-Host "Selected: $LLMProvider" -ForegroundColor Green
$LLMModel = Read-Host "Enter model name (default: $DefaultModel)"
if ([string]::IsNullOrEmpty($LLMModel)) { $LLMModel = $DefaultModel }

$OLLAMA_HOST = ""
$ApiKey = ""
$ApiKeyPlain = ""

if ($LLMProvider -eq "ollama") {
    $OLLAMA_HOST = Read-Host "Enter Ollama Host (default: http://127.0.0.1:11434)"
    if ([string]::IsNullOrEmpty($OLLAMA_HOST)) { $OLLAMA_HOST = "http://127.0.0.1:11434" }
} else {
    Write-Host ""
    $ApiKeySecure = Read-Host "Enter your API key" -AsSecureString
    $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($ApiKeySecure)
    $ApiKeyPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)

    while ([string]::IsNullOrEmpty($ApiKeyPlain)) {
        Write-ColorOutput "API key is required." "Red"
        $ApiKeySecure = Read-Host "Enter your API key" -AsSecureString
        $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($ApiKeySecure)
        $ApiKeyPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
    }
}

# =============================================
# DISCORD CONFIG
# =============================================

Write-Host ""
Write-ColorOutput "Step 5: Integrations (Optional)" "Cyan"
$SetupDiscord = Read-Host "Set up Discord bot? [y/N]"
$DiscordTokenPlain = ""

if ($SetupDiscord -match "^[Yy]") {
    $DiscordTokenSecure = Read-Host "Enter Discord bot token" -AsSecureString
    $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($DiscordTokenSecure)
    $DiscordTokenPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
}

# =============================================
# INSTALLATION
# =============================================

Write-Host ""
Write-ColorOutput "Step 6: Installing Keygate..." "Cyan"

if (!(Test-Path $ConfigDir)) { New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null }
if (!(Test-Path $WorkspaceDir)) { New-Item -ItemType Directory -Force -Path $WorkspaceDir | Out-Null }

if ($InstallDir -ne (Get-Location).Path) {
    if (Test-Path $InstallDir) {
        Write-Host "Directory $InstallDir already exists." -ForegroundColor Yellow
        $Overwrite = Read-Host "Overwrite? [y/N]"
        if ($Overwrite -match "^[Yy]") {
            Remove-Item -Recurse -Force $InstallDir
        }
    }
    
    if (-not (Test-Path $InstallDir)) {
        Write-Host "Cloning repository to $InstallDir..."
        git clone https://github.com/puukis/keygate.git $InstallDir
    }
}

Set-Location $InstallDir

Write-Host "Installing dependencies..." -ForegroundColor Green
Start-Process -FilePath "pnpm" -ArgumentList "install" -Wait
Write-Host "Dependencies installed" -ForegroundColor Green

Write-Host "Building project..." -ForegroundColor Green
Start-Process -FilePath "pnpm" -ArgumentList "build" -Wait
Write-Host "Build complete" -ForegroundColor Green

# =============================================
# WRITE CONFIG
# =============================================

Write-Host "Step 7: Finalizing Configuration..." -ForegroundColor Cyan

$EnvContent = @"
# Keygate Environment Variables
LLM_PROVIDER=$LLMProvider
LLM_MODEL=$LLMModel
LLM_API_KEY=$ApiKeyPlain
LLM_OLLAMA_HOST=$OLLAMA_HOST
SPICY_MODE_ENABLED=$SpicyEnabled
WORKSPACE_PATH=$WorkspaceDir
DISCORD_TOKEN=$DiscordTokenPlain
"@

Set-Content -Path "$ConfigDir\.env" -Value $EnvContent

$ConfigContent = @"
{
  "llm": {
    "provider": "$LLMProvider",
    "model": "$LLMModel"
  },
  "security": {
    "spicyModeEnabled": $SpicyEnabled,
    "workspacePath": "$($WorkspaceDir -replace '\\', '\\\\')",
    "allowedBinaries": ["git", "ls", "npm", "cat", "node", "python3", "pnpm", "yarn"]
  },
  "server": {
    "port": 18790
  },
  "discord": {
    "prefix": "!keygate "
  }
}
"@

Set-Content -Path "$ConfigDir\config.json" -Value $ConfigContent

# =============================================
# LAUNCHER ALIAS
# =============================================

if (!(Test-Path $BinDir)) { New-Item -ItemType Directory -Force -Path $BinDir | Out-Null }
$LauncherPath = "$BinDir\keygate.cmd"
$LauncherContent = @"
@echo off
cd /d "$InstallDir"
pnpm dev
"@

Set-Content -Path $LauncherPath -Value $LauncherContent
Write-ColorOutput "Created 'keygate.cmd' in $BinDir" "Green"

if ($env:Path -notlike "*$BinDir*") {
    Write-ColorOutput "Note: $BinDir is not in your PATH." "Yellow"
    Write-Host "Add it to your User Environment Variables to run 'keygate' from anywhere."
    # Optional: Offer to add to PATH (requires registry access / persistence)
    $AddToPath = Read-Host "Add to User PATH environment variable? (Recommended) [Y/n]"
    if ($AddToPath -eq "" -or $AddToPath -match "^[Yy]$") {
        try {
            $CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
            if ($CurrentPath -notlike "*$BinDir*") {
                [Environment]::SetEnvironmentVariable("Path", "$CurrentPath;$BinDir", "User")
                Write-ColorOutput "✓ Added to User PATH (restart terminal to take effect)" "Green"
            }
        } catch {
            Write-ColorOutput "Failed to update PATH automatically. Please add it manually." "Red"
        }
    }
}

# =============================================
# DONE
# =============================================

Write-Host ""
Write-ColorOutput "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" "Green"
Write-ColorOutput "✅ Installation Successfully Completed!" "Green"
Write-ColorOutput "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" "Green"
Write-Host ""
Write-Host "You can now start Keygate by running:"
Write-ColorOutput "  keygate" "Cyan"
Write-Host ""
Write-Host "(Or by running 'pnpm dev' in the installation directory)"
Write-Host ""

$StartNow = Read-Host "Start Keygate now? [Y/n]"
if ($StartNow -eq "" -or $StartNow -match "^[Yy]$") {
    pnpm dev
}
