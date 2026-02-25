#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
logs_dir="${TMPDIR:-/tmp}/keygate-rebuild-restart"
mkdir -p "$logs_dir"
log_file="$logs_dir/$(date +%Y%m%d-%H%M%S).log"

has_tty=0
if [[ -t 1 ]]; then
  has_tty=1
fi

supports_color=0
if (( has_tty == 1 )) && [[ -z "${NO_COLOR:-}" ]] && [[ "${TERM:-}" != "dumb" ]]; then
  supports_color=1
fi

C_RESET=""
C_BOLD=""
C_DIM=""
C_LINE=""
C_TITLE=""
C_ACCENT_A=""
C_ACCENT_B=""
C_ACCENT_C=""
C_OK=""
C_WARN=""
C_FAIL=""

if (( supports_color == 1 )); then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_LINE=$'\033[38;5;31m'
  C_TITLE=$'\033[38;5;39m'
  C_ACCENT_A=$'\033[38;5;45m'
  C_ACCENT_B=$'\033[38;5;81m'
  C_ACCENT_C=$'\033[38;5;117m'
  C_OK=$'\033[38;5;82m'
  C_WARN=$'\033[38;5;220m'
  C_FAIL=$'\033[38;5;196m'
fi

cursor_hidden=0
cleanup() {
  if (( has_tty == 1 )) && (( cursor_hidden == 1 )); then
    printf '\033[?25h'
    cursor_hidden=0
  fi
}
trap cleanup EXIT INT TERM

hr() {
  local width=80
  local line
  line="$(printf '%*s' "$width" '')"
  line="${line// /-}"
  printf "%s%s%s\n" "$C_LINE" "$line" "$C_RESET"
}

format_duration() {
  local seconds="$1"
  if (( seconds < 60 )); then
    printf "%ss" "$seconds"
    return
  fi

  local minutes=$((seconds / 60))
  local rem=$((seconds % 60))
  printf "%sm%ss" "$minutes" "$rem"
}

build_pulse_bar() {
  local width="$1"
  local tick="$2"
  local head=$((tick % width))
  local tail1=$(((head - 1 + width) % width))
  local tail2=$(((head - 2 + width) % width))
  local tail3=$(((head - 3 + width) % width))
  local i=0
  local out=""

  for ((i = 0; i < width; i++)); do
    if (( i == head )); then
      out+="${C_ACCENT_C}#${C_RESET}"
    elif (( i == tail1 )); then
      out+="${C_ACCENT_B}#${C_RESET}"
    elif (( i == tail2 )); then
      out+="${C_ACCENT_A}#${C_RESET}"
    elif (( i == tail3 )); then
      out+="${C_LINE}#${C_RESET}"
    else
      out+="${C_DIM}.${C_RESET}"
    fi
  done

  printf "%s" "$out"
}

animate_loading_bar() {
  local pid="$1"
  local prefix="$2"
  local label="$3"
  local started_at="$4"
  local width=28
  local tick=0
  local spinner='|/-\'
  local spin=""
  local elapsed=0
  local padded_label=""
  local bar=""

  printf -v padded_label "%-28s" "$label"

  while kill -0 "$pid" 2>/dev/null; do
    spin="${spinner:tick%4:1}"
    elapsed=$(( $(date +%s) - started_at ))
    bar="$(build_pulse_bar "$width" "$tick")"

    printf "\r\033[2K%s[%s]%s %s%s%s %s%s%s [%s] %s%s%s" \
      "$C_DIM" "$prefix" "$C_RESET" \
      "$C_BOLD" "$padded_label" "$C_RESET" \
      "$C_ACCENT_C" "$spin" "$C_RESET" \
      "$bar" \
      "$C_DIM" "$(format_duration "$elapsed")" "$C_RESET"

    tick=$((tick + 1))
    sleep 0.06
  done

  printf "\r\033[2K"
}

print_step_result() {
  local kind="$1"
  local label="$2"
  local elapsed="$3"
  local color="$4"

  printf "%s[%s]%s %s%s%s %s(%s)%s\n" \
    "$color" "$kind" "$C_RESET" \
    "$C_BOLD" "$label" "$C_RESET" \
    "$C_DIM" "$(format_duration "$elapsed")" "$C_RESET"
}

last_step_duration=0
run_step() {
  local prefix="$1"
  local label="$2"
  shift 2
  local status=0
  local started_at
  started_at="$(date +%s)"

  if (( has_tty == 1 )); then
    "$@" >>"$log_file" 2>&1 &
    local pid=$!
    if (( cursor_hidden == 0 )); then
      printf '\033[?25l'
      cursor_hidden=1
    fi
    animate_loading_bar "$pid" "$prefix" "$label" "$started_at"
    if wait "$pid"; then
      status=0
    else
      status=$?
    fi
  else
    if "$@" >>"$log_file" 2>&1; then
      status=0
    else
      status=$?
    fi
  fi

  last_step_duration=$(( $(date +%s) - started_at ))
  return "$status"
}

total_steps=6
step_index=0

run_optional_step() {
  local label="$1"
  shift
  step_index=$((step_index + 1))
  local prefix=""
  printf -v prefix "%02d/%02d" "$step_index" "$total_steps"

  if run_step "$prefix" "$label" "$@"; then
    print_step_result "OK  " "$label" "$last_step_duration" "$C_OK"
    return 0
  fi

  print_step_result "SKIP" "$label (continuing)" "$last_step_duration" "$C_WARN"
  return 0
}

run_required_step() {
  local label="$1"
  shift
  step_index=$((step_index + 1))
  local prefix=""
  printf -v prefix "%02d/%02d" "$step_index" "$total_steps"

  if run_step "$prefix" "$label" "$@"; then
    print_step_result "OK  " "$label" "$last_step_duration" "$C_OK"
    return 0
  fi

  local status=$?
  print_step_result "FAIL" "$label" "$last_step_duration" "$C_FAIL"
  printf "%sCheck log:%s %s\n" "$C_DIM" "$C_RESET" "$log_file"
  exit "$status"
}

cd "$repo_root"

hr
printf "%s%sKEYGATE REBUILD + RESTART%s\n" "$C_BOLD" "$C_TITLE" "$C_RESET"
printf "%sProject:%s %s\n" "$C_DIM" "$C_RESET" "$repo_root"
printf "%sLog:%s %s\n" "$C_DIM" "$C_RESET" "$log_file"
hr

run_optional_step "Closing Keygate gateway" pnpm keygate gateway close
run_required_step "Installing dependencies" pnpm install
run_required_step "Building project" pnpm build
run_required_step "Opening Keygate gateway" pnpm keygate gateway open

cd "$repo_root/packages/macos"

run_required_step "Building Swift app" swift build
run_required_step "Running Keygate" swift run Keygate
