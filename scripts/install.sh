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
WORKSPACE_DIR="$HOME/keygate-workspace"
INSTALL_DIR="$HOME/.local/share/keygate"

echo -e "${PURPLE}"
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║                                                               ║"
echo "║   ⚡ KEYGATE INSTALLER                                        ║"
echo "║   Personal AI Agent Gateway                                   ║"
echo "║                                                               ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# =============================================
# LEGAL DISCLAIMER & SPICY MODE OPT-IN
# =============================================

echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${RED}⚠️  IMPORTANT SAFETY DISCLAIMER${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "Keygate is an AI agent that can execute commands on your computer."
echo ""
echo -e "${GREEN}SAFE MODE (Default):${NC}"
echo "  • File operations restricted to ~/keygate-workspace"
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
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "To ${RED}enable Spicy Mode${NC}, type exactly: ${YELLOW}I ACCEPT THE RISK${NC}"
echo -e "To continue with ${GREEN}Safe Mode only${NC}, press Enter."
echo ""
read -r -p "> " RISK_INPUT

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

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}🤖 LLM Configuration${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "Select your LLM provider:"
echo "  1) OpenAI (gpt-4o, gpt-4-turbo, etc.)"
echo "  2) Google Gemini (gemini-1.5-pro, gemini-1.5-flash, etc.)"
echo ""
read -r -p "Enter choice [1/2]: " PROVIDER_CHOICE

case $PROVIDER_CHOICE in
    2)
        LLM_PROVIDER="gemini"
        DEFAULT_MODEL="gemini-1.5-pro"
        ;;
    *)
        LLM_PROVIDER="openai"
        DEFAULT_MODEL="gpt-4o"
        ;;
esac

echo -e "\nSelected: ${GREEN}$LLM_PROVIDER${NC}"
echo ""
read -r -p "Enter model name (default: $DEFAULT_MODEL): " LLM_MODEL
LLM_MODEL=${LLM_MODEL:-$DEFAULT_MODEL}

echo ""
read -r -s -p "Enter your API key: " API_KEY
echo ""

if [ -z "$API_KEY" ]; then
    echo -e "${RED}Error: API key is required${NC}"
    exit 1
fi

# =============================================
# DISCORD (OPTIONAL)
# =============================================

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}🤖 Discord Bot (Optional)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
read -r -p "Set up Discord bot? [y/N]: " SETUP_DISCORD

DISCORD_TOKEN=""
if [[ "$SETUP_DISCORD" =~ ^[Yy]$ ]]; then
    read -r -s -p "Enter Discord bot token: " DISCORD_TOKEN
    echo ""
fi

# =============================================
# CREATE DIRECTORIES AND CONFIG
# =============================================

echo ""
echo -e "${GREEN}Creating directories...${NC}"

mkdir -p "$CONFIG_DIR"
mkdir -p "$WORKSPACE_DIR"
mkdir -p "$INSTALL_DIR"

echo -e "  ✓ Config dir: ${CONFIG_DIR}"
echo -e "  ✓ Workspace: ${WORKSPACE_DIR}"
echo -e "  ✓ Install dir: ${INSTALL_DIR}"

# Create .env file
echo -e "\n${GREEN}Writing configuration...${NC}"

cat > "$CONFIG_DIR/.env" << EOF
# Keygate Environment Variables
LLM_PROVIDER=$LLM_PROVIDER
LLM_MODEL=$LLM_MODEL
LLM_API_KEY=$API_KEY
SPICY_MODE_ENABLED=$SPICY_ENABLED
WORKSPACE_PATH=$WORKSPACE_DIR
DISCORD_TOKEN=$DISCORD_TOKEN
EOF

chmod 600 "$CONFIG_DIR/.env"
echo -e "  ✓ Created ${CONFIG_DIR}/.env"

# Create config.json
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

echo -e "  ✓ Created ${CONFIG_DIR}/config.json"

# =============================================
# INSTALL DEPENDENCIES (if running locally)
# =============================================

echo ""
echo -e "${GREEN}Checking Node.js...${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${RED}Node.js not found. Please install Node.js 22+ first.${NC}"
    echo "Visit: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
    echo -e "${YELLOW}Warning: Node.js version $NODE_VERSION detected. Keygate requires Node.js 22+${NC}"
fi

echo -e "  ✓ Node.js $(node -v) detected"

# =============================================
# DONE
# =============================================

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ Installation Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "To start Keygate:"
echo ""
echo -e "  ${BLUE}cd /path/to/keygate${NC}"
echo -e "  ${BLUE}pnpm install${NC}"
echo -e "  ${BLUE}pnpm dev${NC}"
echo ""
echo "Then open: http://localhost:18789"
echo ""

if [ "$SPICY_ENABLED" = "true" ]; then
    echo -e "${RED}⚠️  REMINDER: Spicy Mode is ENABLED. Be extremely careful!${NC}"
    echo ""
fi

echo "Enjoy using Keygate! ⚡"
