#!/bin/bash
set -e

# ==============================================================================
#  Keygate Installer
#  Aesthetic, high-fidelity installer for the Keygate AI Gateway
# ==============================================================================

# ------------------------------------------------------------------------------
#  Configuration & Constants
# ------------------------------------------------------------------------------
VERSION="2026.2.3-1"
COMMIT_HASH="d84eb46"
CONFIG_DIR="$HOME/.config/keygate"
DEFAULT_INSTALL_DIR="$HOME/.local/share/keygate"
BIN_DIR="$HOME/.local/bin"

# ANSI Colors & Styles
ESC_SEQ=$'\033'
COL_SEQ="${ESC_SEQ}["
RESET="${COL_SEQ}0m"
BOLD="${COL_SEQ}1m"
DIM="${COL_SEQ}2m"
ITALIC="${COL_SEQ}3m"
UNDERLINE="${COL_SEQ}4m"

# Brand Colors (Keygate Palette)
C_BRAND="${COL_SEQ}38;5;202m"    # Orange/Red
C_CYAN="${COL_SEQ}36m"             # Cyan
C_GREEN="${COL_SEQ}32m"            # Green
C_RED="${COL_SEQ}31m"              # Red
C_YELLOW="${COL_SEQ}33m"           # Yellow/Orange
C_GRAY="${COL_SEQ}90m"             # Dark Gray
C_WHITE="${COL_SEQ}37m"            # White

# Symbols
S_CHECK="${C_GREEN}✓${RESET}"
S_CROSS="${C_RED}✗${RESET}"
S_WARN="${C_YELLOW}⚠${RESET}"
S_ARROW="${C_GRAY}→${RESET}"
S_DOT_EMPTY="${C_GRAY}○${RESET}"
S_DOT_FULL="${C_WHITE}●${RESET}"
S_TREE_V="${C_GRAY}│${RESET}"
S_TREE_H="${C_GRAY}─${RESET}"
S_TREE_BRANCH="${C_GRAY}├${RESET}"
S_TREE_END="${C_GRAY}└${RESET}"
S_TREE_TOP="${C_GRAY}┌${RESET}"
S_DIAMOND="${C_GREEN}◇${RESET}"
S_DIAMOND_FILL="${C_GREEN}◆${RESET}"
S_BRAND="⚡"

# ------------------------------------------------------------------------------
#  UI Helper Functions
# ------------------------------------------------------------------------------

cursor_hide() { printf "${COL_SEQ}?25l"; }
cursor_show() { printf "${COL_SEQ}?25h"; }
trap cursor_show EXIT

print_banner() {
    clear
    echo -e "${C_BRAND}  ${S_BRAND} Keygate Installer${RESET}"
    echo -e "  ${DIM}Works on Mac. Crazy concept, we know.${RESET}"
    echo ""
}

print_header() {
    clear
    echo ""
    echo -e "${C_BRAND}  ${S_BRAND} Keygate ${VERSION} (${COMMIT_HASH}) ${RESET}"
    echo ""
    echo -e "${C_GRAY}██╗  ██╗███████╗██╗   ██╗ ██████╗  █████╗ ████████╗███████╗${RESET}"
    echo -e "${C_GRAY}██║ ██╔╝██╔════╝╚██╗ ██╔╝██╔════╝ ██╔══██╗╚══██╔══╝██╔════╝${RESET}"
    echo -e "${C_GRAY}█████╔╝ █████╗   ╚████╔╝ ██║  ███╗███████║   ██║   █████╗  ${RESET}"
    echo -e "${C_GRAY}██╔═██╗ ██╔══╝    ╚██╔╝  ██║   ██║██╔══██║   ██║   ██╔══╝  ${RESET}"
    echo -e "${C_GRAY}██║  ██╗███████╗   ██║   ╚██████╔╝██║  ██║   ██║   ███████╗${RESET}"
    echo -e "${C_GRAY}╚═╝  ╚═╝╚══════╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝${RESET}"
    echo -e "                  ${C_BRAND}⚡ KEYGATE ⚡${RESET}                    "
    echo ""
}

# $1: Indentation level (0-based)
# $2: Text
log_tree_start() {
    echo -e "${S_TREE_TOP}  ${BOLD}${1}${RESET}"
}

log_tree_item() {
    echo -e "${S_TREE_V}"
    echo -e "${S_DIAMOND}  ${1}"
}

log_tree_item_active() {
    echo -e "${S_TREE_V}"
    echo -e "${S_DIAMOND_FILL}  ${BOLD}${1}${RESET}"
}

log_tree_subitem() {
    echo -e "${S_TREE_V}  ${DIM}${1}${RESET}"
}

log_tree_end() {
    echo -e "${S_TREE_END}"
}

# Read one navigation key from /dev/tty in a way that's safe with `set -e`.
# Supports plain keys, Enter, and arrow sequences from different terminals.
read_menu_key() {
    local first=""
    local second=""
    local third=""

    if ! read -rsn1 first < /dev/tty; then
        MENU_KEY=""
        return 1
    fi

    if [[ "$first" == "$ESC_SEQ" ]]; then
        # Arrow keys are typically ESC [ A/B or ESC O A/B depending on terminal mode.
        read -rsn1 -t 1 second < /dev/tty || second=""
        if [[ "$second" == "[" || "$second" == "O" ]]; then
            read -rsn1 -t 1 third < /dev/tty || third=""
            MENU_KEY="${second}${third}"
            return 0
        fi
        MENU_KEY="$second"
        return 0
    fi

    MENU_KEY="$first"
    return 0
}

# $1: Variable to store result
# $2: Prompt question
prompt_yes_no() {
    local prompt="$1"
    local selected=0 # 0=Yes, 1=No
    
    cursor_hide
    while true; do
        # Draw
        if [ $selected -eq 0 ]; then
            echo -e "${S_TREE_V}  ${S_DOT_FULL} Yes"
            echo -e "${S_TREE_V}  ${S_DOT_EMPTY} No"
        else
            echo -e "${S_TREE_V}  ${S_DOT_EMPTY} Yes"
            echo -e "${S_TREE_V}  ${S_DOT_FULL} No"
        fi
        echo -e "${S_TREE_END}"

        # Input
        if ! read_menu_key; then
            echo -e "${S_TREE_V}  ${S_CROSS} Failed to read keyboard input from terminal."
            return 1
        fi
        
        # Mapping: 
        # ESC -> Arrow Key Sequence?
        # w/k -> Up
        # s/j -> Down
        # Enter -> Confirm

        if [[ "$MENU_KEY" == "[A" || "$MENU_KEY" == "OA" ]]; then # Up
                selected=0
        elif [[ "$MENU_KEY" == "[B" || "$MENU_KEY" == "OB" ]]; then # Down
                selected=1
        elif [[ "$MENU_KEY" == "w" || "$MENU_KEY" == "k" || "$MENU_KEY" == "W" || "$MENU_KEY" == "K" ]]; then # Up
            selected=0
        elif [[ "$MENU_KEY" == "s" || "$MENU_KEY" == "j" || "$MENU_KEY" == "S" || "$MENU_KEY" == "J" ]]; then # Down
            selected=1
        elif [[ -z "$MENU_KEY" ]]; then # Enter
            break
        fi

        # Move cursor up 3 lines to redraw (Yes, No, End)
        printf "${COL_SEQ}3A"
    done
    
    # Clear the options lines (3 lines now)
    printf "${COL_SEQ}2K${COL_SEQ}1A${COL_SEQ}2K${COL_SEQ}1A${COL_SEQ}2K"
    
    # Print the selected option as a static log
    if [ $selected -eq 0 ]; then
        echo -e "${S_TREE_V}  ${DIM}Yes${RESET}"
        return 0
    else
        echo -e "${S_TREE_V}  ${DIM}No${RESET}"
        return 1
    fi
}

# $1: Title
# $2...: Options
prompt_list() {
    local title="$1"
    shift
    local options=("$@")
    local selected=0
    local num_options=${#options[@]}
    
    cursor_hide
    while true; do
        for ((i=0; i<num_options; i++)); do
            if [ $i -eq $selected ]; then
                echo -e "${S_TREE_V}  ${S_DOT_FULL} ${BOLD}${options[$i]}${RESET}"
            else
                echo -e "${S_TREE_V}  ${S_DOT_EMPTY} ${options[$i]}"
            fi
        done
        echo -e "${S_TREE_END}"

        if ! read_menu_key; then
            echo -e "${S_TREE_V}  ${S_CROSS} Failed to read keyboard input from terminal."
            return 1
        fi
        
        if [[ "$MENU_KEY" == "[A" || "$MENU_KEY" == "OA" ]]; then # Up
            selected=$((selected - 1))
            if [ $selected -lt 0 ]; then selected=$((num_options-1)); fi
        elif [[ "$MENU_KEY" == "[B" || "$MENU_KEY" == "OB" ]]; then # Down
            selected=$((selected + 1))
            if [ $selected -ge $num_options ]; then selected=0; fi
        elif [[ "$MENU_KEY" == "w" || "$MENU_KEY" == "k" || "$MENU_KEY" == "W" || "$MENU_KEY" == "K" ]]; then # Up
            selected=$((selected - 1))
            if [ $selected -lt 0 ]; then selected=$((num_options-1)); fi
        elif [[ "$MENU_KEY" == "s" || "$MENU_KEY" == "j" || "$MENU_KEY" == "S" || "$MENU_KEY" == "J" ]]; then # Down
             selected=$((selected + 1))
             if [ $selected -ge $num_options ]; then selected=0; fi
        elif [[ -z "$MENU_KEY" ]]; then # Enter
            break
        fi

        # Move cursor up N+1 lines (Options + End)
        printf "${COL_SEQ}$((num_options+1))A"
    done
    
    # Clear lines (Options + End)
    printf "${COL_SEQ}$((num_options+1))A"
    for ((i=0; i<=num_options; i++)); do # <= to include the End line
        printf "${COL_SEQ}2K${COL_SEQ}1B"
    done
    printf "${COL_SEQ}$((num_options+1))A" # Back to start
    
    echo -e "${S_TREE_V}  ${DIM}${options[$selected]}${RESET}" 
    
    PROMPT_RETURN=$selected
    return 0
}

spinner() {
    local pid=$1
    local delay=0.1
    local spinstr='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    while [ "$(ps a | awk '{print $1}' | grep $pid)" ]; do
        local temp=${spinstr#?}
        printf "${C_BRAND}%c${RESET}" "$spinstr"
        local spinstr=$temp${spinstr%"$temp"}
        sleep $delay
        printf "\b"
    done
    printf " " # Clear spinner char
    printf "\b"
}

print_security_box() {
    echo -e "${S_TREE_V}"
    echo -e "${S_DIAMOND}  ${BOLD}Security${RESET} ${C_GRAY}─────────────────────────────────────────────────────────────╮${RESET}"
    echo -e "${S_TREE_V}                                                                        ${S_TREE_V}"
    echo -e "${S_TREE_V}  ${BOLD}MUST READ SECURITY NOTICE${RESET}                                              ${S_TREE_V}"
    echo -e "${S_TREE_V}                                                                        ${S_TREE_V}"
    echo -e "${S_TREE_V}  Keygate bridges AI models directly to your operating system.          ${S_TREE_V}"
    echo -e "${S_TREE_V}  This agent has actual agency: it can read, write, and execute.        ${S_TREE_V}"
    echo -e "${S_TREE_V}                                                                        ${S_TREE_V}"
    echo -e "${S_TREE_V}  YOU are responsible for the actions this agent takes.                 ${S_TREE_V}"
    echo -e "${S_TREE_V}  Never give it easier access than you would a junior dev.              ${S_TREE_V}"
    echo -e "${S_TREE_V}                                                                        ${S_TREE_V}"
    echo -e "${S_TREE_V}  ${DIM}Safety Protocols:${RESET}                                                     ${S_TREE_V}"
    echo -e "${S_TREE_V}  ${DIM}- Default: Run in a Docker container or restricted VM.${RESET}                ${S_TREE_V}"
    echo -e "${S_TREE_V}  ${DIM}- Monitor: Keep 'Safe Mode' enabled for critical tasks.${RESET}               ${S_TREE_V}"
    echo -e "${S_TREE_V}  ${DIM}- Isolate: Don't store secrets in the workspace root.${RESET}                 ${S_TREE_V}"
    echo -e "${S_TREE_V}                                                                        ${S_TREE_V}"
    echo -e "${S_TREE_V}  ${DIM}Full policy: docs/SECURITY.md${RESET}                                         ${S_TREE_V}"
    echo -e "${S_TREE_V}                                                                        ${S_TREE_V}"
    echo -e "${S_TREE_BRANCH}────────────────────────────────────────────────────────────────────────╯"
}

# ------------------------------------------------------------------------------
#  Main Script
# ------------------------------------------------------------------------------

# 1. Quick Prerequisite Checks (Silent unless error)
print_banner

if ! command -v git &> /dev/null; then
    echo -e "${S_CROSS} Git not found."
    exit 1
fi
OS_DETECTED=$(uname -s)
if [ "$OS_DETECTED" == "Darwin" ]; then
    OS_DETECTED="MacOS"
fi
echo -e "${S_CHECK} Detected: $OS_DETECTED"
echo -e "${S_CHECK} Git detected"

if ! command -v node &> /dev/null; then
    echo -e "${S_CROSS} Node.js not found."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
    echo -e "${S_WARN} Node.js v${NODE_VERSION} detected (v22+ required)"
    # We could exit here or prompt, but for aesthetics let's just warn for now
    # exit 1
else
    echo -e "${S_CHECK} Node.js $(node -v) found"
fi

echo -e "${S_ARROW} Starting setup..."
sleep 1

# 2. Main Onboarding Flow
print_header
log_tree_start "Keygate onboarding"

# Security Section
print_security_box

echo -e "${S_TREE_V}"
log_tree_item_active "I understand this is powerful and inherently risky. Continue?"
echo -e "${S_TREE_V}  ${DIM}(Use Arrow keys, WASD, or j/k to navigate)${RESET}"


if prompt_yes_no; then
    # User said YES
    :
else
    # User said NO
    echo -e "${S_TREE_END}"
    echo -e "\n${C_YELLOW}Aborted by user.${RESET}"
    exit 0
fi

# Onboarding Mode
echo -e "${S_TREE_V}"
log_tree_item_active "Onboarding mode"
OPTIONS=("QuickStart (Configure details later via config.json)" "Manual")
prompt_list "Onboarding mode" "${OPTIONS[@]}"
MODE_IDX=$PROMPT_RETURN

if [ $MODE_IDX -eq 0 ]; then
    # QuickStart
    echo -e "${S_TREE_V}"
    log_tree_item "QuickStart ─────────────────────────╮"
    log_tree_subitem "Gateway port: 18790"
    log_tree_subitem "Gateway bind: Loopback (127.0.0.1)"
    log_tree_subitem "Tailscale exposure: Off"
    echo -e "${S_TREE_BRANCH}──────────────────────────────────────╯"
fi

# LLM Provider
echo -e "${S_TREE_V}"
log_tree_item_active "Model/auth provider"
PROVIDERS=("OpenAI (GPT-4o)" "Anthropic (Claude 3.5 Sonnet)" "Google (Gemini 1.5 Pro)" "Ollama (Local)" "Skip for now")
prompt_list "Model/auth provider" "${PROVIDERS[@]}"
PROVIDER_IDX=$PROMPT_RETURN

LLM_PROVIDER=""
DEFAULT_MODEL=""
OLLAMA_HOST=""
API_KEY=""

case $PROVIDER_IDX in
    0) LLM_PROVIDER="openai"; DEFAULT_MODEL="gpt-4o" ;;
    1) LLM_PROVIDER="anthropic"; DEFAULT_MODEL="claude-3-5-sonnet-20241022" ;;
    2) LLM_PROVIDER="gemini"; DEFAULT_MODEL="gemini-1.5-pro" ;;
    3) LLM_PROVIDER="ollama"; DEFAULT_MODEL="llama3" ;;
    *) LLM_PROVIDER="unknown";;
esac

# API Key / Local Config Input
if [ "$LLM_PROVIDER" != "unknown" ]; then
    if [ "$LLM_PROVIDER" == "ollama" ]; then
        echo -e "${S_TREE_V}"
        log_tree_item_active "Ollama Host URL"
        echo -n -e "${S_TREE_V}  ${S_ARROW} Enter host (default: http://127.0.0.1:11434): "
        cursor_show
        read -r input_host < /dev/tty
        cursor_hide
        OLLAMA_HOST=${input_host:-"http://127.0.0.1:11434"}
        # Move cursor up to overwrite the input line with a clean log
        printf "${COL_SEQ}1A${COL_SEQ}2K"
        echo -e "${S_TREE_V}  ${DIM}${OLLAMA_HOST}${RESET}"

        # Model Selection
        echo -e "${S_TREE_V}"
        log_tree_item_active "Ollama Model"
        
        # Try to fetch models
        if command -v ollama &> /dev/null; then
            AVAILABLE_MODELS=$(OLLAMA_HOST="$OLLAMA_HOST" ollama list 2>/dev/null | awk 'NR>1 {print $1}')
        else
            AVAILABLE_MODELS=""
        fi

        if [ -z "$AVAILABLE_MODELS" ]; then
             echo -e "${S_TREE_V}  ${S_WARN} Could not list models (Ollama not running or no models pulled)."
             echo -n -e "${S_TREE_V}  ${S_ARROW} Enter model to use (default: llama3): "
             cursor_show
             read -r input_model < /dev/tty
             cursor_hide
             DEFAULT_MODEL=${input_model:-"llama3"}
             # Clean up UI
             printf "${COL_SEQ}1A${COL_SEQ}2K"
             echo -e "${S_TREE_V}  ${DIM}${DEFAULT_MODEL}${RESET}"
             
             # Warn if they might need to pull it
             echo -e "${S_TREE_V}  ${S_WARN} Make sure to run: ${BOLD}ollama pull ${DEFAULT_MODEL}${RESET}"
        else
             # Convert to array (Bash 3.2 safe manual split)
             mk_array() {
                 local ifs_save="$IFS"
                 IFS=$'\n'
                 MODEL_OPTIONS=($1)
                 IFS="$ifs_save"
             }
             mk_array "$AVAILABLE_MODELS"
             
             MODEL_OPTIONS+=("Custom...")
             
             prompt_list "Select Model" "${MODEL_OPTIONS[@]}"
             MODEL_IDX=$PROMPT_RETURN
             
             # Check if last item (Custom) selected
             # We can't easily check 'Custom...' string equality if prompt_list returns index
             # but we know the size.
             CNT=${#MODEL_OPTIONS[@]}
             CUSTOM_IDX=$((CNT-1))

             if [ $MODEL_IDX -eq $CUSTOM_IDX ]; then
                 echo -n -e "${S_TREE_V}  ${S_ARROW} Enter model name: "
                 cursor_show
                 read -r input_model < /dev/tty
                 cursor_hide
                 DEFAULT_MODEL=$input_model
                 printf "${COL_SEQ}1A${COL_SEQ}2K"
                 echo -e "${S_TREE_V}  ${DIM}${DEFAULT_MODEL}${RESET}"
             else
                 DEFAULT_MODEL="${MODEL_OPTIONS[$MODEL_IDX]}"
             fi
        fi
    else
        echo -e "${S_TREE_V}"
        log_tree_item_active "API Key (${PROVIDERS[$PROVIDER_IDX]})"
        echo -n -e "${S_TREE_V}  ${S_ARROW} "
        cursor_show
        read -r -s input_key < /dev/tty
        cursor_hide
        echo ""
        API_KEY=$input_key
        # Move cursor up to overwrite
        printf "${COL_SEQ}2A${COL_SEQ}2K" # 2 lines because echo "" added a newline
        printf "${COL_SEQ}1B" # Move down one to clear the correct line? No.
        
        # Redraw cleanly
        # Actually, simpler:
        echo -e "${S_TREE_V}  ${DIM}************************${RESET}"
    fi
fi

log_tree_end


# ------------------------------------------------------------------------------
#  Installation Logic
# ------------------------------------------------------------------------------

echo ""
echo -e "${C_BRAND}→ Installing Keygate ${VERSION}...${RESET}"

# Determine Install Dir
INSTALL_DIR="$DEFAULT_INSTALL_DIR"
if [ -f "package.json" ] && grep -q "keygate" "package.json"; then
    INSTALL_DIR=$(pwd)
fi

mkdir -p "$CONFIG_DIR"
mkdir -p "$HOME/.local/share" # Parent of install dir

# Clone if needed
if [ ! -d "$INSTALL_DIR/.git" ]; then
   if [ "$INSTALL_DIR" != "$(pwd)" ]; then
       echo -e "${C_GRAY}  Cloning to $INSTALL_DIR...${RESET}"
       git clone https://github.com/puukis/keygate.git "$INSTALL_DIR" > /dev/null 2>&1
   fi
fi

cd "$INSTALL_DIR"

# Install Deps
echo -n -e "${C_GRAY}  Installing dependencies... ${RESET}"
pnpm install > /dev/null 2>&1 & # TODO: Handle error
spinner $!
echo -e "${S_CHECK}"

# Build
echo -n -e "${C_GRAY}  Building project...        ${RESET}"
pnpm build > /dev/null 2>&1 &
spinner $!
echo -e "${S_CHECK}"

# Write Config
echo -n -e "${C_GRAY}  Writing configuration...   ${RESET}"

cat > "$CONFIG_DIR/.env" << EOF
LLM_PROVIDER=$LLM_PROVIDER
LLM_MODEL=$DEFAULT_MODEL
LLM_API_KEY=$API_KEY
LLM_OLLAMA_HOST=$OLLAMA_HOST
WORKSPACE_PATH=$HOME/keygate-workspace
EOF
chmod 600 "$CONFIG_DIR/.env"

cat > "$CONFIG_DIR/config.json" << EOF
{
  "llm": { "provider": "$LLM_PROVIDER", "model": "$DEFAULT_MODEL" },
  "security": { "spicyModeEnabled": false, "workspacePath": "$HOME/keygate-workspace" },
   "server": { "port": 18790 }
}
EOF
sleep 0.5
echo -e "${S_CHECK}"


# ------------------------------------------------------------------------------
#  Success
# ------------------------------------------------------------------------------

echo ""
echo -e "${C_BRAND}Keygate installed successfully (${VERSION})!${RESET}"
echo -e "I'm in. Let's cause some responsible chaos."
echo ""
echo -e "Run ${BOLD}pnpm dev${RESET} to start."
echo ""
