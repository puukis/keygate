#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

# Config paths
CONFIG_DIR="$HOME/.config/keygate"
DEFAULT_INSTALL_DIR="$HOME/.local/share/keygate"
BIN_DIR="$HOME/.local/bin"

# Helper for spinner
spinner() {
    local pid=$1
    local delay=0.1
    local spinstr='|/-\'
    while [ "$(ps a | awk '{print $1}' | grep $pid)" ]; do
        local temp=${spinstr#?}
        printf " [%c]  " "$spinstr"
        local spinstr=$temp${spinstr%"$temp"}
        sleep $delay
        printf "\b\b\b\b\b\b"
    done
    printf "    \b\b\b\b"
}

clear

echo -e "${PURPLE}"
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║                                                               ║"
echo "║   ⚡ KEYGATE INSTALLER                                        ║"
echo "║   Personal AI Agent Gateway                                   ║"
echo "║                                                               ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${BLUE}Welcome to the Keygate setup wizard!${NC}"
echo "This script will install Keygate and configure your environment."
echo ""
read -r -p "Press Enter to continue..." < /dev/tty

# =============================================
# PREREQUISITE CHECK
# =============================================

echo -e "\n${BLUE}Step 1: Checking Prerequisites...${NC}"

if ! command -v git &> /dev/null; then
    echo -e "${RED}❌ git is not installed.${NC} Please install git first."
    exit 1
fi
echo -e "${GREEN}✓ git found${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js is not installed.${NC} Please install Node.js 22+ first."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
    echo -e "${YELLOW}⚠️  Warning: Node.js version $NODE_VERSION detected. Keygate requires Node.js 22+${NC}"
    read -r -p "Continue anyway? [y/N]: " CONTINUE_NODE < /dev/tty
    if [[ ! "$CONTINUE_NODE" =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo -e "${GREEN}✓ Node.js $(node -v) found${NC}"
fi

# Check for pnpm
if ! command -v pnpm &> /dev/null; then
    echo -e "${YELLOW}⚠️  pnpm not found. Installing pnpm via corepack...${NC}"
    corepack enable
    corepack prepare pnpm@latest --activate
    if ! command -v pnpm &> /dev/null; then
         echo -e "${RED}❌ Failed to install pnpm automatically.${NC}"
         echo "Please run: npm install -g pnpm"
         exit 1
    fi
fi
echo -e "${GREEN}✓ pnpm $(pnpm -v) found${NC}"

# =============================================
# INSTALL LOCATION
# =============================================

echo -e "\n${BLUE}Step 2: Installation Location${NC}"

# Detect if we are running inside the repo
if [ -f "package.json" ] && grep -q "keygate" "package.json"; then
    CURRENT_DIR=$(pwd)
    echo -e "Detected running inside Keygate repository at: ${YELLOW}$CURRENT_DIR${NC}"
    echo "Do you want to configure this existing installation?"
    read -r -p "Install here? [Y/n]: " INSTALL_HERE < /dev/tty
    INSTALL_HERE=${INSTALL_HERE:-Y}

    if [[ "$INSTALL_HERE" =~ ^[Yy]$ ]]; then
        INSTALL_DIR="$CURRENT_DIR"
    else
        read -r -p "Enter installation path [$DEFAULT_INSTALL_DIR]: " INSTALL_DIR < /dev/tty
        INSTALL_DIR=${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}
    fi
else
    read -r -p "Enter installation path [$DEFAULT_INSTALL_DIR]: " INSTALL_DIR < /dev/tty
    INSTALL_DIR=${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}
fi

WORKSPACE_DIR="$HOME/keygate-workspace"
echo -e "Keygate Workspace will be created at: ${YELLOW}$WORKSPACE_DIR${NC}"

# =============================================
# LEGAL DISCLAIMER & SPICY MODE OPT-IN
# =============================================

echo -e "\n${BLUE}Step 3: Security Configuration${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${RED}⚠️  IMPORTANT SAFETY DISCLAIMER${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "Keygate is an AI agent that can execute commands on your computer."
echo ""
echo -e "${GREEN}SAFE MODE (Default):${NC}"
echo "  • File operations restricted to $WORKSPACE_DIR"
echo "  • Only allowed commands: git, ls, npm, cat, node, python3"
echo "  • All write/execute actions require your confirmation"
echo ""
echo -e "${RED}SPICY MODE (Dangerous):${NC}"
echo "  • FULL access to your entire filesystem"
echo "  • Can run ANY command without restrictions"
echo "  • NO confirmation prompts - autonomous execution"
echo ""
echo -e "${RED}Spicy Mode should ONLY be used in sandboxed/VM environments.${NC}"
echo ""
echo -e "To ${RED}enable Spicy Mode${NC}, type exactly: ${YELLOW}I ACCEPT THE RISK${NC}"
echo -e "To continue with ${GREEN}Safe Mode only${NC}, press Enter."
echo ""
read -r -p "> " RISK_INPUT < /dev/tty

SPICY_ENABLED="false"
if [ "$RISK_INPUT" = "I ACCEPT THE RISK" ]; then
    SPICY_ENABLED="true"
    echo -e "\n${RED}⚠️  SPICY MODE ENABLED${NC} - You have been warned!\n"
else
    echo -e "\n${GREEN}✓ Safe Mode only${NC} - Good choice!\n"
fi

# =============================================
# LLM CONFIGURATION
# =============================================

echo -e "${BLUE}Step 4: AI Model Configuration${NC}"

echo "Select your LLM provider:"
echo "  1) OpenAI (gpt-4o, gpt-4-turbo, etc.)"
echo "  2) Google Gemini (gemini-1.5-pro, gemini-1.5-flash, etc.)"
echo "  3) local Ollama (llama3, mistral, deepseek-r1, etc.)"
echo ""
read -r -p "Enter choice [1/2/3]: " PROVIDER_CHOICE < /dev/tty

case $PROVIDER_CHOICE in
    2)
        LLM_PROVIDER="gemini"
        DEFAULT_MODEL="gemini-1.5-pro"
        ;;
    3)
        LLM_PROVIDER="ollama"
        DEFAULT_MODEL="llama3"
        ;;
    *)
        LLM_PROVIDER="openai"
        DEFAULT_MODEL="gpt-4o"
        ;;
esac

echo -e "\nSelected: ${GREEN}$LLM_PROVIDER${NC}"
read -r -p "Enter model name (default: $DEFAULT_MODEL): " LLM_MODEL < /dev/tty
LLM_MODEL=${LLM_MODEL:-$DEFAULT_MODEL}

API_KEY=""
OLLAMA_HOST=""

if [ "$LLM_PROVIDER" = "ollama" ]; then
    echo ""
    read -r -p "Enter Ollama Host (default: http://127.0.0.1:11434): " OLLAMA_HOST < /dev/tty
    OLLAMA_HOST=${OLLAMA_HOST:-http://127.0.0.1:11434}
else
    echo ""
    read -r -s -p "Enter your API key: " API_KEY < /dev/tty
    echo ""

    while [ -z "$API_KEY" ]; do
        echo -e "${RED}API key is required for $LLM_PROVIDER.${NC}"
        read -r -s -p "Enter your API key: " API_KEY < /dev/tty
        echo ""
    done
fi

# =============================================
# DISCORD (OPTIONAL)
# =============================================

echo -e "\n${BLUE}Step 5: Integrations (Optional)${NC}"
read -r -p "Set up Discord bot? [y/N]: " SETUP_DISCORD < /dev/tty

DISCORD_TOKEN=""
if [[ "$SETUP_DISCORD" =~ ^[Yy]$ ]]; then
    read -r -s -p "Enter Discord bot token: " DISCORD_TOKEN < /dev/tty
    echo ""
fi

# =============================================
# INSTALLATION & BUILD
# =============================================

echo -e "\n${BLUE}Step 6: Installing Keygate...${NC}"

mkdir -p "$CONFIG_DIR"
mkdir -p "$WORKSPACE_DIR"

if [ "$INSTALL_DIR" != "$(pwd)" ]; then
    if [ -d "$INSTALL_DIR" ]; then
        echo -e "${YELLOW}Directory $INSTALL_DIR already exists.${NC}"
        read -r -p "Overwrite? This will delete existing files [y/N]: " OVERWRITE < /dev/tty
        if [[ "$OVERWRITE" =~ ^[Yy]$ ]]; then
            rm -rf "$INSTALL_DIR"
        else
            echo "Update existing installation? [Y/n]"
            read -r UPDATE_EXISTING < /dev/tty
             # Logic to pull latest changes could go here
        fi
    fi

    if [ ! -d "$INSTALL_DIR" ]; then
        echo -e "Cloning repository to $INSTALL_DIR..."
        git clone https://github.com/puukis/keygate.git "$INSTALL_DIR"
    fi
fi

cd "$INSTALL_DIR"

echo -e "\n${GREEN}Installing dependencies (this may take a moment)...${NC}"
pnpm install > /dev/null 2>&1 &
spinner $!
echo -e "${GREEN}✓ Dependencies installed${NC}"

echo -e "\n${GREEN}Building project...${NC}"
pnpm build > /dev/null 2>&1 &
spinner $!
echo -e "${GREEN}✓ Build complete${NC}"

# =============================================
# WRITE CONFIG
# =============================================

echo -e "\n${BLUE}Step 7: Finalizing Configuration...${NC}"

cat > "$CONFIG_DIR/.env" << EOF
# Keygate Environment Variables
LLM_PROVIDER=$LLM_PROVIDER
LLM_MODEL=$LLM_MODEL
LLM_API_KEY=$API_KEY
LLM_OLLAMA_HOST=$OLLAMA_HOST
SPICY_MODE_ENABLED=$SPICY_ENABLED
WORKSPACE_PATH=$WORKSPACE_DIR
DISCORD_TOKEN=$DISCORD_TOKEN
EOF

chmod 600 "$CONFIG_DIR/.env"

cat > "$CONFIG_DIR/config.json" << EOF
{
  "llm": {
    "provider": "$LLM_PROVIDER",
    "model": "$LLM_MODEL"
  },
  "security": {
    "spicyModeEnabled": $SPICY_ENABLED,
    "workspacePath": "$WORKSPACE_DIR",
    "allowedBinaries": ["git", "ls", "npm", "cat", "node", "python3", "pnpm", "yarn"]
  },
  "server": {
    "port": 18790
  },
  "discord": {
    "prefix": "!keygate "
  }
}
EOF

# =============================================
# GLOBAL ALIAS
# =============================================

mkdir -p "$BIN_DIR"
LAUNCHER="$BIN_DIR/keygate"

echo "#!/bin/bash" > "$LAUNCHER"
echo "cd \"$INSTALL_DIR\" && pnpm dev" >> "$LAUNCHER"
chmod +x "$LAUNCHER"

echo -e "${GREEN}Created 'keygate' command in $BIN_DIR${NC}"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    echo -e "${YELLOW}Note: $BIN_DIR is not in your PATH.${NC}"
    echo "Add this to your shell profile (e.g. ~/.zshrc):"
    echo "export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# =============================================
# DONE
# =============================================

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ Installation Successfully Completed!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "You can now start Keygate by running:"
echo -e "  ${BLUE}keygate${NC}"
echo ""
echo "(Or by running 'pnpm dev' in the installation directory)"
echo ""

read -r -p "Start Keygate now? [Y/n]: " START_NOW < /dev/tty
START_NOW=${START_NOW:-Y}

if [[ "$START_NOW" =~ ^[Yy]$ ]]; then
    pnpm dev
fi
