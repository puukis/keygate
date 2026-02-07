#!/usr/bin/env bash
set -euo pipefail

VERSION="2026.2.7"
PACKAGE_NAME="${KEYGATE_NPM_PACKAGE:-@keygate/cli}"
PACKAGE_VERSION="${KEYGATE_VERSION:-latest}"
CONFIG_DIR="$HOME/.config/keygate"
WORKSPACE_DIR="$HOME/keygate-workspace"
ORIGINAL_PATH="${PATH:-}"

NO_PROMPT="${KEYGATE_NO_PROMPT:-0}"
NO_ONBOARD="${KEYGATE_NO_ONBOARD:-0}"
DRY_RUN="${KEYGATE_DRY_RUN:-0}"
VERBOSE="${KEYGATE_VERBOSE:-0}"
NO_RUN="${KEYGATE_NO_RUN:-0}"

KEYGATE_BIN=""

ESC=$'\033'
RESET="${ESC}[0m"
BOLD="${ESC}[1m"
DIM="${ESC}[2m"
GREEN="${ESC}[32m"
YELLOW="${ESC}[33m"
RED="${ESC}[31m"
CYAN="${ESC}[36m"

print_usage() {
  cat <<USAGE
Keygate installer

Usage:
  ./scripts/install.sh [options]

Options:
  --no-prompt    Disable interactive prompts
  --no-onboard   Skip onboarding and write default config
  --dry-run      Print actions without mutating the system
  --verbose      Enable shell tracing
  --no-run       Do not start keygate at the end
  --help, -h     Show this help
USAGE
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-prompt)
        NO_PROMPT="1"
        shift
        ;;
      --no-onboard)
        NO_ONBOARD="1"
        shift
        ;;
      --dry-run)
        DRY_RUN="1"
        shift
        ;;
      --verbose)
        VERBOSE="1"
        shift
        ;;
      --no-run)
        NO_RUN="1"
        shift
        ;;
      --help|-h)
        print_usage
        exit 0
        ;;
      *)
        echo -e "${RED}Unknown option: $1${RESET}"
        print_usage
        exit 2
        ;;
    esac
  done
}

configure_verbose() {
  if [[ "$VERBOSE" == "1" ]]; then
    set -x
  fi
}

is_promptable() {
  if [[ "$NO_PROMPT" == "1" ]]; then
    return 1
  fi
  [[ -r /dev/tty && -w /dev/tty ]]
}

run_cmd() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo -e "${DIM}[dry-run] $*${RESET}"
    return 0
  fi
  "$@"
}

log_info() {
  echo -e "${CYAN}i${RESET} $*"
}

log_ok() {
  echo -e "${GREEN}✓${RESET} $*"
}

log_warn() {
  echo -e "${YELLOW}!${RESET} $*"
}

log_error() {
  echo -e "${RED}x${RESET} $*"
}

prompt_yes_no() {
  local prompt="$1"
  local default_yes="$2"
  local answer=""

  if ! is_promptable; then
    [[ "$default_yes" == "1" ]]
    return
  fi

  if [[ "$default_yes" == "1" ]]; then
    echo -n "$prompt [Y/n]: " > /dev/tty
  else
    echo -n "$prompt [y/N]: " > /dev/tty
  fi

  read -r answer < /dev/tty || true
  answer="${answer:-}"

  if [[ -z "$answer" ]]; then
    [[ "$default_yes" == "1" ]]
    return
  fi

  [[ "$answer" =~ ^[Yy]$ ]]
}

prompt_text() {
  local prompt="$1"
  local default_value="$2"
  local answer=""

  if ! is_promptable; then
    printf '%s' "$default_value"
    return
  fi

  if [[ -n "$default_value" ]]; then
    echo -n "$prompt [$default_value]: " > /dev/tty
  else
    echo -n "$prompt: " > /dev/tty
  fi

  read -r answer < /dev/tty || true
  if [[ -z "$answer" ]]; then
    printf '%s' "$default_value"
  else
    printf '%s' "$answer"
  fi
}

prompt_secret() {
  local prompt="$1"
  local answer=""

  if ! is_promptable; then
    printf ''
    return
  fi

  echo -n "$prompt: " > /dev/tty
  stty -echo < /dev/tty
  read -r answer < /dev/tty || true
  stty echo < /dev/tty
  echo "" > /dev/tty
  printf '%s' "$answer"
}

check_prerequisites() {
  echo -e "${BOLD}Keygate installer ${VERSION}${RESET}"

  if ! command -v node >/dev/null 2>&1; then
    log_error "Node.js is required (v22+)."
    exit 1
  fi

  local node_major
  node_major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [[ "$node_major" -lt 22 ]]; then
    log_error "Node.js $(node -v) detected. Node.js v22+ is required."
    exit 1
  fi
  log_ok "Node.js $(node -v) found"

  if ! command -v npm >/dev/null 2>&1; then
    log_error "npm is required."
    exit 1
  fi
  log_ok "npm $(npm -v) found"
}

npm_global_bin_dir() {
  local prefix=""
  prefix="$(npm prefix -g 2>/dev/null || true)"
  if [[ -n "$prefix" ]]; then
    if [[ "$(uname -s)" == "Darwin" || "$(uname -s)" == "Linux" ]]; then
      echo "${prefix%/}/bin"
      return 0
    fi
  fi
  echo ""
  return 1
}

resolve_keygate_bin() {
  if command -v keygate >/dev/null 2>&1; then
    command -v keygate
    return 0
  fi

  local npm_bin=""
  npm_bin="$(npm_global_bin_dir || true)"
  if [[ -n "$npm_bin" && -x "$npm_bin/keygate" ]]; then
    echo "$npm_bin/keygate"
    return 0
  fi

  return 1
}

warn_path_if_missing() {
  local npm_bin=""
  npm_bin="$(npm_global_bin_dir || true)"
  if [[ -z "$npm_bin" ]]; then
    return
  fi

  case ":$ORIGINAL_PATH:" in
    *":$npm_bin:"*)
      return
      ;;
  esac

  log_warn "PATH may not include npm global bin: $npm_bin"
  echo "Add this to your shell profile if 'keygate' is not found:"
  echo "  export PATH=\"$npm_bin:\$PATH\""
}

install_keygate_global() {
  local spec="$PACKAGE_NAME@$PACKAGE_VERSION"
  log_info "Installing $spec globally via npm"

  if [[ "$DRY_RUN" == "1" ]]; then
    echo -e "${DIM}[dry-run] npm install -g $spec${RESET}"
    KEYGATE_BIN="keygate"
    return
  fi

  if ! npm --no-fund --no-audit install -g "$spec"; then
    log_warn "Initial npm install failed. Retrying once..."
    npm --no-fund --no-audit install -g "$spec"
  fi

  hash -r 2>/dev/null || true
  KEYGATE_BIN="$(resolve_keygate_bin || true)"
  if [[ -z "$KEYGATE_BIN" ]]; then
    warn_path_if_missing
    log_error "Installation completed but 'keygate' is not discoverable on PATH."
    exit 1
  fi

  log_ok "Installed keygate binary at: $KEYGATE_BIN"
}

run_codex_login() {
  if ! is_promptable; then
    return 1
  fi

  log_info "Starting Codex login now..."
  if "$KEYGATE_BIN" auth login --provider openai-codex < /dev/tty; then
    log_ok "Codex login completed"
    return 0
  fi

  log_warn "Codex login failed or was cancelled."
  return 1
}

open_url_in_background() {
  local url="$1"
  local os="$(uname -s)"

  if [[ "$DRY_RUN" == "1" ]]; then
    echo -e "${DIM}[dry-run] open URL $url${RESET}"
    return 0
  fi

  if [[ "$os" == "Darwin" ]]; then
    (sleep 2; open "$url" >/dev/null 2>&1 || true) &
    return 0
  fi

  if command -v xdg-open >/dev/null 2>&1; then
    (sleep 2; xdg-open "$url" >/dev/null 2>&1 || true) &
  fi
}

write_config_files() {
  local llm_provider="$1"
  local llm_model="$2"
  local llm_api_key="$3"
  local llm_ollama_host="$4"
  local spicy_mode_enabled="$5"

  log_info "Writing configuration files to $CONFIG_DIR"

  run_cmd mkdir -p "$CONFIG_DIR"
  run_cmd mkdir -p "$WORKSPACE_DIR"

  if [[ "$DRY_RUN" == "1" ]]; then
    return
  fi

  cat > "$CONFIG_DIR/.env" <<ENV
LLM_PROVIDER=$llm_provider
LLM_MODEL=$llm_model
LLM_API_KEY=$llm_api_key
LLM_OLLAMA_HOST=$llm_ollama_host
SPICY_MODE_ENABLED=$spicy_mode_enabled
WORKSPACE_PATH=$WORKSPACE_DIR
PORT=18790
ENV
  chmod 600 "$CONFIG_DIR/.env"

  cat > "$CONFIG_DIR/config.json" <<JSON
{
  "llm": {
    "provider": "$llm_provider",
    "model": "$llm_model"
  },
  "security": {
    "spicyModeEnabled": $spicy_mode_enabled,
    "workspacePath": "$WORKSPACE_DIR",
    "allowedBinaries": ["git", "ls", "npm", "cat", "node", "python3"]
  },
  "server": {
    "port": 18790
  }
}
JSON

  log_ok "Configuration saved"
}

run_onboarding() {
  local llm_provider="openai"
  local llm_model="gpt-4o"
  local llm_api_key=""
  local llm_ollama_host=""
  local spicy_mode_enabled="false"

  if [[ "$NO_ONBOARD" == "1" ]]; then
    log_info "Skipping onboarding (--no-onboard)."
    write_config_files "$llm_provider" "$llm_model" "$llm_api_key" "$llm_ollama_host" "$spicy_mode_enabled"
    return
  fi

  if ! is_promptable; then
    log_warn "No interactive TTY available. Applying deterministic defaults."
    write_config_files "$llm_provider" "$llm_model" "$llm_api_key" "$llm_ollama_host" "$spicy_mode_enabled"
    return
  fi

  echo ""
  echo "Keygate can execute commands on your machine."
  if ! prompt_yes_no "Continue with setup?" "1"; then
    log_warn "Installer aborted by user."
    exit 0
  fi

  local risk_ack=""
  risk_ack="$(prompt_text "Type I ACCEPT THE RISK to enable Spicy Mode (or press Enter for Safe Mode)" "")"
  if [[ "$risk_ack" == "I ACCEPT THE RISK" ]]; then
    spicy_mode_enabled="true"
    log_warn "Spicy Mode enabled"
  else
    spicy_mode_enabled="false"
    log_ok "Safe Mode enabled"
  fi

  while true; do
    echo ""
    echo "Choose provider:"
    echo "  1) OpenAI"
    echo "  2) OpenAI Codex (ChatGPT OAuth)"
    echo "  3) Google Gemini"
    echo "  4) Ollama"
    echo "  5) Skip for now"
    local choice
    choice="$(prompt_text "Enter choice" "2")"

    case "$choice" in
      1)
        llm_provider="openai"
        llm_model="$(prompt_text "OpenAI model" "gpt-4o")"
        llm_api_key="$(prompt_secret "OpenAI API key")"
        break
        ;;
      2)
        llm_provider="openai-codex"
        llm_model="$(prompt_text "Codex model" "openai-codex/gpt-5.3")"
        llm_api_key=""
        llm_ollama_host=""
        if run_codex_login; then
          break
        fi
        log_info "Returning to provider selection..."
        ;;
      3)
        llm_provider="gemini"
        llm_model="$(prompt_text "Gemini model" "gemini-1.5-pro")"
        llm_api_key="$(prompt_secret "Gemini API key")"
        break
        ;;
      4)
        llm_provider="ollama"
        llm_model="$(prompt_text "Ollama model" "llama3")"
        llm_ollama_host="$(prompt_text "Ollama host" "http://127.0.0.1:11434")"
        llm_api_key=""
        break
        ;;
      5)
        llm_provider="openai"
        llm_model="gpt-4o"
        llm_api_key=""
        llm_ollama_host=""
        break
        ;;
      *)
        log_warn "Invalid choice."
        ;;
    esac
  done

  write_config_files "$llm_provider" "$llm_model" "$llm_api_key" "$llm_ollama_host" "$spicy_mode_enabled"
}

finish_and_maybe_run() {
  local chat_url="${KEYGATE_CHAT_URL:-http://localhost:18790}"

  echo ""
  log_ok "Keygate installed successfully"
  echo "Command: keygate"
  echo "Chat URL: $chat_url"

  if [[ "$NO_RUN" == "1" || "$NO_PROMPT" == "1" ]]; then
    echo ""
    echo "Run manually when ready:"
    echo "  keygate"
    echo "Then open: $chat_url"
    return
  fi

  if ! is_promptable; then
    echo ""
    echo "Run manually when ready:"
    echo "  keygate"
    echo "Then open: $chat_url"
    return
  fi

  if prompt_yes_no "Run the Keygate web app now?" "1"; then
    open_url_in_background "$chat_url"
    if [[ "$DRY_RUN" == "1" ]]; then
      echo -e "${DIM}[dry-run] $KEYGATE_BIN${RESET}"
      return
    fi
    exec "$KEYGATE_BIN"
  fi

  echo ""
  echo "Run manually when ready:"
  echo "  keygate"
  echo "Then open: $chat_url"
}

main() {
  parse_args "$@"
  configure_verbose

  if [[ "$NO_PROMPT" == "1" ]]; then
    NO_RUN="1"
  fi

  check_prerequisites
  install_keygate_global
  warn_path_if_missing
  run_onboarding
  finish_and_maybe_run
}

main "$@"
