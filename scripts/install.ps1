# Keygate Installer for Windows
# Run with: powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"

# Config paths
$ConfigDir = "$env:USERPROFILE\.config\keygate"
$WorkspaceDir = "$env:USERPROFILE\keygate-workspace"
$InstallDir = "$env:LOCALAPPDATA\keygate"

function Write-ColorOutput($ForegroundColor) {
    $fc = $host.UI.RawUI.ForegroundColor
    $host.UI.RawUI.ForegroundColor = $ForegroundColor
    if ($args) {
        Write-Output $args
    }
    $host.UI.RawUI.ForegroundColor = $fc
}

# Banner
Write-Host ""
Write-Host "╔═══════════════════════════════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "║                                                               ║" -ForegroundColor Magenta
Write-Host "║   ⚡ KEYGATE INSTALLER                                        ║" -ForegroundColor Magenta
Write-Host "║   Personal AI Agent Gateway                                   ║" -ForegroundColor Magenta
Write-Host "║                                                               ║" -ForegroundColor Magenta
Write-Host "╚═══════════════════════════════════════════════════════════════╝" -ForegroundColor Magenta
Write-Host ""

# =============================================
# LEGAL DISCLAIMER & SPICY MODE OPT-IN
# =============================================

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
Write-Host "⚠️  IMPORTANT SAFETY DISCLAIMER" -ForegroundColor Red
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
Write-Host ""
Write-Host "Keygate is an AI agent that can execute commands on your computer."
Write-Host ""
Write-Host "SAFE MODE (Default):" -ForegroundColor Green
Write-Host "  • File operations restricted to ~/keygate-workspace"
Write-Host "  • Only allowed commands: git, ls, npm, cat, node, python3"
Write-Host "  • All write/execute actions require your confirmation"
Write-Host ""
Write-Host "SPICY MODE (Dangerous):" -ForegroundColor Red
Write-Host "  • FULL access to your entire filesystem"
Write-Host "  • Can run ANY command without restrictions"
Write-Host "  • NO confirmation prompts - autonomous execution"
Write-Host ""
Write-Host "Spicy Mode should ONLY be used in sandboxed/VM environments." -ForegroundColor Red
Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
Write-Host ""
Write-Host "To " -NoNewline
Write-Host "enable Spicy Mode" -ForegroundColor Red -NoNewline
Write-Host ", type exactly: " -NoNewline
Write-Host "I ACCEPT THE RISK" -ForegroundColor Yellow
Write-Host "To continue with Safe Mode only, press Enter."
Write-Host ""

$RiskInput = Read-Host "> "
$SpicyEnabled = "false"

if ($RiskInput -eq "I ACCEPT THE RISK") {
    $SpicyEnabled = "true"
    Write-Host ""
    Write-Host "⚠️  SPICY MODE ENABLED - You have been warned!" -ForegroundColor Red
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "✓ Safe Mode only - Good choice!" -ForegroundColor Green
    Write-Host ""
}

# =============================================
# LLM CONFIGURATION
# =============================================

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Blue
Write-Host "🤖 LLM Configuration" -ForegroundColor Blue
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Blue
Write-Host ""
Write-Host "Select your LLM provider:"
Write-Host "  1) OpenAI (gpt-4o, gpt-4-turbo, etc.)"
Write-Host "  2) Google Gemini (gemini-1.5-pro, gemini-1.5-flash, etc.)"
Write-Host ""

$ProviderChoice = Read-Host "Enter choice [1/2]"

switch ($ProviderChoice) {
    "2" {
        $LLMProvider = "gemini"
        $DefaultModel = "gemini-1.5-pro"
    }
    default {
        $LLMProvider = "openai"
        $DefaultModel = "gpt-4o"
    }
}

Write-Host ""
Write-Host "Selected: $LLMProvider" -ForegroundColor Green
Write-Host ""

$LLMModel = Read-Host "Enter model name (default: $DefaultModel)"
if ([string]::IsNullOrEmpty($LLMModel)) {
    $LLMModel = $DefaultModel
}

Write-Host ""
$ApiKeySecure = Read-Host "Enter your API key" -AsSecureString
$ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ApiKeySecure)
)

if ([string]::IsNullOrEmpty($ApiKey)) {
    Write-Host "Error: API key is required" -ForegroundColor Red
    exit 1
}

# =============================================
# DISCORD (OPTIONAL)
# =============================================

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Blue
Write-Host "🤖 Discord Bot (Optional)" -ForegroundColor Blue
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Blue
Write-Host ""

$SetupDiscord = Read-Host "Set up Discord bot? [y/N]"
$DiscordToken = ""

if ($SetupDiscord -match "^[Yy]$") {
    $DiscordTokenSecure = Read-Host "Enter Discord bot token" -AsSecureString
    $DiscordToken = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($DiscordTokenSecure)
    )
}

# =============================================
# CREATE DIRECTORIES AND CONFIG
# =============================================

Write-Host ""
Write-Host "Creating directories..." -ForegroundColor Green

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
New-Item -ItemType Directory -Force -Path $WorkspaceDir | Out-Null
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Write-Host "  ✓ Config dir: $ConfigDir"
Write-Host "  ✓ Workspace: $WorkspaceDir"
Write-Host "  ✓ Install dir: $InstallDir"

# Create .env file
Write-Host ""
Write-Host "Writing configuration..." -ForegroundColor Green

$EnvContent = @"
# Keygate Environment Variables
LLM_PROVIDER=$LLMProvider
LLM_MODEL=$LLMModel
LLM_API_KEY=$ApiKey
SPICY_MODE_ENABLED=$SpicyEnabled
WORKSPACE_PATH=$WorkspaceDir
DISCORD_TOKEN=$DiscordToken
"@

Set-Content -Path "$ConfigDir\.env" -Value $EnvContent
Write-Host "  ✓ Created $ConfigDir\.env"

# Create config.json
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
Write-Host "  ✓ Created $ConfigDir\config.json"

# =============================================
# CHECK NODE.JS
# =============================================

Write-Host ""
Write-Host "Checking Node.js..." -ForegroundColor Green

try {
    $NodeVersion = (node -v) -replace 'v', ''
    $MajorVersion = [int]($NodeVersion.Split('.')[0])
    
    if ($MajorVersion -lt 22) {
        Write-Host "Warning: Node.js version $NodeVersion detected. Keygate requires Node.js 22+" -ForegroundColor Yellow
    }
    Write-Host "  ✓ Node.js v$NodeVersion detected"
} catch {
    Write-Host "Node.js not found. Please install Node.js 22+ first." -ForegroundColor Red
    Write-Host "Visit: https://nodejs.org/"
    exit 1
}

# =============================================
# DONE
# =============================================

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host "✅ Installation Complete!" -ForegroundColor Green
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host ""
Write-Host "To start Keygate:"
Write-Host ""
Write-Host "  cd \path\to\keygate" -ForegroundColor Blue
Write-Host "  pnpm install" -ForegroundColor Blue
Write-Host "  pnpm dev" -ForegroundColor Blue
Write-Host ""
Write-Host "Then open: http://localhost:18789"
Write-Host ""

if ($SpicyEnabled -eq "true") {
    Write-Host "⚠️  REMINDER: Spicy Mode is ENABLED. Be extremely careful!" -ForegroundColor Red
    Write-Host ""
}

Write-Host "Enjoy using Keygate! ⚡"
