#!/bin/bash

################################################################################
# Sogni Voice API - Interactive Setup Script
#
# This script provides one-click setup for the Sogni Voice API, including:
# - System requirements verification
# - TTS engine selection (Kokoro, Pocket, MOSS, Qwen)
# - STT and speaker diarization selection
# - Environment configuration
# - API key setup
# - Dependency installation
#
# Usage: ./setup.sh
#        ./setup.sh --non-interactive  (localhost defaults: Pocket TTS + Parakeet, no auth)
################################################################################

set -e  # Exit on error

# Modes
NON_INTERACTIVE=0
for arg in "$@"; do
    case "$arg" in
        --non-interactive|--non-interactive-localhost)
            NON_INTERACTIVE=1
            ;;
    esac
done

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

# Symbols
CHECK="${GREEN}✓${NC}"
CROSS="${RED}✗${NC}"
WARN="${YELLOW}⚠${NC}"
INFO="${BLUE}ℹ${NC}"

################################################################################
# Utility Functions
################################################################################

print_header() {
    echo ""
    echo "════════════════════════════════════════════════════════════════════════════════"
    echo -e "${BLUE}$1${NC}"
    echo "════════════════════════════════════════════════════════════════════════════════"
    echo ""
}

print_success() {
    echo -e "${CHECK} $1"
}

print_error() {
    echo -e "${CROSS} $1"
}

print_warning() {
    echo -e "${WARN} $1"
}

print_info() {
    echo -e "${INFO} $1"
}

ensure_env_newline() {
    # Ensure .env ends with a newline to avoid concatenating entries
    if [ -f .env ] && [ -s .env ]; then
        local last_char
        last_char=$(tail -c 1 .env 2>/dev/null || true)
        if [ -n "$last_char" ]; then
            echo "" >> .env
        fi
    fi
}

append_env_line() {
    local line="$1"
    ensure_env_newline
    echo "$line" >> .env
}

upsert_env_key() {
    local key="$1"
    local value="$2"
    if grep -q "^[# ]*${key}=" .env 2>/dev/null; then
        sed -i.bak "s|^[# ]*${key}=.*|${key}=${value}|" .env
    else
        append_env_line "${key}=${value}"
    fi
}

version_ge() {
    # Compare versions: returns 0 if $1 >= $2
    printf '%s\n%s' "$2" "$1" | sort -V -C
}

python_is_stable_release() {
    local python_cmd="$1"
    "$python_cmd" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if sys.version_info.releaselevel == "final" else 1)
PY
}

venv_is_healthy() {
    [ -x .venv/bin/python ] || return 1

    .venv/bin/python - <<'PY' >/dev/null 2>&1
import sys

if sys.version_info.releaselevel != "final":
    raise SystemExit(1)

# Sanity-check pip's vendored packaging parser. This catches broken
# prerelease/Python combinations that fail on any pip install.
from pip._vendor.packaging.version import Version

Version("1.0")
PY
}

huggingface_credentials_available() {
    [ -n "${HF_TOKEN:-}" ] ||
        grep -Eq '^HF_TOKEN=.+$' .env 2>/dev/null ||
        [ -f "$HOME/.cache/huggingface/token" ] ||
        [ -f "$HOME/.huggingface/token" ]
}

################################################################################
# Interactive Menu Functions
################################################################################

# Checkbox menu for multi-select
# Usage: show_checkbox_menu "Title" "initial_selections" "option1" "option2" ...
# Sets global variable MENU_RESULT to space-separated list of 1s and 0s
show_checkbox_menu() {
    local title="$1"
    shift
    local selections_str="$1"
    shift
    local options=("$@")

    # Convert string to array
    IFS=' ' read -ra selections <<< "$selections_str"

    local current=0

    # Hide cursor
    tput civis

    while true; do
        clear
        echo ""
        echo -e "${CYAN}${BOLD}$title${NC}"
        echo -e "${DIM}Use ↑/↓ to navigate, SPACE to toggle, ENTER to confirm${NC}"
        echo ""

        for i in "${!options[@]}"; do
            local prefix="  "
            if [ $i -eq $current ]; then
                prefix="${CYAN}▶${NC} "
            fi

            local checkbox="[ ]"
            if [ "${selections[$i]}" = "1" ]; then
                checkbox="${GREEN}[✓]${NC}"
            fi

            echo -e "${prefix}${checkbox} ${options[$i]}"
        done

        # Read single character (no echo, raw mode)
        IFS= read -rsn1 key 2>/dev/null

        # Handle key presses using case statement
        case "$key" in
            $'\x1b')  # ESC - arrow keys send: ESC [ A/B/C/D
                read -rsn1 bracket 2>/dev/null
                read -rsn1 direction 2>/dev/null
                if [[ "$bracket" == "[" ]]; then
                    case "$direction" in
                        A)  # Up arrow
                            ((current--))
                            [ $current -lt 0 ] && current=$((${#options[@]} - 1))
                            ;;
                        B)  # Down arrow
                            ((current++))
                            [ $current -ge ${#options[@]} ] && current=0
                            ;;
                    esac
                fi
                ;;
            '')  # Enter key
                break
                ;;
            ' ')  # Spacebar
                if [ "${selections[$current]}" = "1" ]; then
                    selections[$current]=0
                else
                    selections[$current]=1
                fi
                ;;
        esac
    done

    # Show cursor
    tput cnorm
    clear

    # Set global result variable
    MENU_RESULT="${selections[*]}"
}

# Radio menu for single-select
# Usage: show_radio_menu "Title" default_index "option1" "option2" ...
# Sets global variable MENU_RESULT to index of selected option (0-based)
show_radio_menu() {
    local title="$1"
    shift
    local current="${1:-0}"
    shift
    local options=("$@")

    # Hide cursor
    tput civis

    while true; do
        clear
        echo ""
        echo -e "${CYAN}${BOLD}$title${NC}"
        echo -e "${DIM}Use ↑/↓ to navigate, ENTER to select${NC}"
        echo ""

        for i in "${!options[@]}"; do
            local prefix="  "
            if [ $i -eq $current ]; then
                prefix="${CYAN}▶${NC} "
            fi

            local radio="( )"
            if [ $i -eq $current ]; then
                radio="${GREEN}(●)${NC}"
            fi

            echo -e "${prefix}${radio} ${options[$i]}"
        done

        # Read single character (no echo, raw mode)
        IFS= read -rsn1 key 2>/dev/null

        # Handle key presses using case statement
        case "$key" in
            $'\x1b')  # ESC - arrow keys send: ESC [ A/B/C/D
                read -rsn1 bracket 2>/dev/null
                read -rsn1 direction 2>/dev/null
                if [[ "$bracket" == "[" ]]; then
                    case "$direction" in
                        A)  # Up arrow
                            ((current--))
                            [ $current -lt 0 ] && current=$((${#options[@]} - 1))
                            ;;
                        B)  # Down arrow
                            ((current++))
                            [ $current -ge ${#options[@]} ] && current=0
                            ;;
                    esac
                fi
                ;;
            '')  # Enter key
                break
                ;;
        esac
    done

    # Show cursor
    tput cnorm
    clear

    # Set global result variable
    MENU_RESULT="$current"
}

################################################################################
# System Requirements Check
################################################################################

check_system_requirements() {
    print_header "Step 1: Checking System Requirements"

    local all_good=true

    # Check macOS on Apple Silicon
    if [[ "$(uname)" != "Darwin" ]]; then
        print_error "This project requires macOS"
        all_good=false
    else
        print_success "Running on macOS"

        # Check for Apple Silicon
        if [[ "$(uname -m)" == "arm64" ]]; then
            print_success "Apple Silicon detected ($(uname -m))"
        else
            print_warning "Not running on Apple Silicon (detected: $(uname -m))"
            print_info "The project is optimized for Apple Silicon (M1/M2/M3/M4)"
        fi
    fi

    # Check Node.js
    if command -v node >/dev/null 2>&1; then
        local node_version=$(node --version | sed 's/v//')
        if version_ge "$node_version" "18.0.0"; then
            print_success "Node.js $node_version (≥18.0.0 required)"
        else
            print_error "Node.js $node_version is too old (≥18.0.0 required)"
            print_info "Install via: brew install node"
            all_good=false
        fi
    else
        print_error "Node.js not found"
        print_info "Install via: brew install node"
        all_good=false
    fi

    # Check Python (prefer Homebrew versions over system Python)
    PYTHON_CMD=""
    local python_version=""
    local python_candidates=("python3.13" "python3.12" "python3.11" "python3.10" "python3")
    local candidate=""
    for candidate in "${python_candidates[@]}"; do
        if command -v "$candidate" >/dev/null 2>&1; then
            local candidate_version
            candidate_version=$("$candidate" --version 2>&1 | awk '{print $2}')
            if python_is_stable_release "$candidate"; then
                PYTHON_CMD="$candidate"
                python_version="$candidate_version"
                break
            fi
            print_warning "Ignoring prerelease Python $candidate_version ($candidate)"
        fi
    done

    if [ -n "$PYTHON_CMD" ]; then
        if version_ge "$python_version" "3.10.0"; then
            print_success "Python $python_version ($PYTHON_CMD) (≥3.10 required)"
        else
            print_error "Python $python_version is too old (≥3.10 required)"
            print_info "Install via: brew install python@3.11"
            all_good=false
        fi
    else
        print_error "No stable Python 3.10+ interpreter found"
        print_info "Install via: brew install python@3.11"
        all_good=false
    fi

    # Check ffmpeg
    if command -v ffmpeg >/dev/null 2>&1; then
        local ffmpeg_version=$(ffmpeg -version | head -n1 | awk '{print $3}')
        print_success "ffmpeg $ffmpeg_version"
    else
        print_error "ffmpeg not found"
        print_info "Install via: brew install ffmpeg"
        all_good=false
    fi

    # Check sox
    if command -v sox >/dev/null 2>&1; then
        local sox_version=$(sox --version | awk '{print $NF}')
        print_success "sox $sox_version"
    else
        print_error "sox not found"
        print_info "Install via: brew install sox"
        all_good=false
    fi

    # Check uv
    if command -v uv >/dev/null 2>&1; then
        local uv_version=$(uv --version | awk '{print $2}')
        print_success "uv $uv_version"
    else
        print_error "uv not found"
        print_info "Install via: brew install uv"
        all_good=false
    fi

    if [ "$all_good" = false ]; then
        echo ""
        print_error "Please install missing dependencies and run this script again"
        exit 1
    fi

    echo ""
}

################################################################################
# TTS Engine Selection
################################################################################

select_tts_engines() {
    echo ""
    print_header "Step 2: Select TTS Engines"

    if [ "$NON_INTERACTIVE" = "1" ]; then
        # Localhost-safe defaults for automated setup:
        # - Pocket TTS only
        # - Parakeet enabled
        # - No auth (configured in setup_api_key)
        ENABLE_POCKET=1
        ENABLE_KOKORO=0
        ENABLE_QWEN=0
        ENABLE_MOSS=0
        ENABLE_FISH=0
        ENABLE_PARAKEET=1
        ENABLE_QWEN_ASR=0
        ENABLE_MOSS_TD=0
        ENABLE_DIARIZATION=0
        QWEN_BASE_VARIANT="base-0.6b"
        QWEN_CUSTOM_VARIANT="custom-voice"
        QWEN_VARIANT="$QWEN_BASE_VARIANT"

        print_info "Non-interactive mode: using defaults"
        print_info "- Pocket TTS: enabled"
        print_info "- Kokoro TTS: disabled"
        print_info "- Qwen3-TTS: disabled"
        print_info "- MOSS-TTS-Nano: disabled"
        print_info "- Parakeet STT: enabled"
        print_info "- Qwen3-ASR: disabled"
        print_info "- MOSS Transcribe-Diarize: disabled (experimental)"
        print_info "- Speaker diarization: disabled (requires gated-model access)"
        return
    fi

    # Checkbox menu for TTS engines
    local tts_options=(
        "Pocket TTS (Fast, CPU-only, 8 English voices, voice cloning) - Recommended"
        "Kokoro TTS (Mid, MLX-based, 32 voices, 4 languages)"
        "Qwen3-TTS (MLX, 10 languages, cloning, style control, voice design)"
        "MOSS-TTS-Nano (100M, multilingual reference voices, MLX, 48 kHz)"
        "Fish S2 Pro (8-bit MLX, expressive inline emotion + voice cloning) - Non-commercial, ~6.7GB"
    )

    # Get selections via global MENU_RESULT (Pocket=yes; others disabled by default)
    show_checkbox_menu "Select TTS Engines to Enable" "1 0 0 0 0" "${tts_options[@]}"
    IFS=' ' read -ra tts_selected <<< "$MENU_RESULT"

    ENABLE_POCKET=${tts_selected[0]}
    ENABLE_KOKORO=${tts_selected[1]}
    ENABLE_QWEN=${tts_selected[2]}
    ENABLE_MOSS=${tts_selected[3]}
    ENABLE_FISH=${tts_selected[4]}

    # Qwen uses separate daemons for cloning, styled voices, and voice design.
    # Select a paired Base/CustomVoice profile; VoiceDesign remains a lazy model.
    if [ "$ENABLE_QWEN" = "1" ]; then
        echo ""
        local qwen_options=(
            "Balanced: 0.6B cloning + 1.7B styled voices - Recommended"
            "Quality: 1.7B cloning + 1.7B styled voices"
            "Compact: 0.6B cloning + 0.6B styled voices"
        )

        show_radio_menu "Select Qwen3-TTS MLX Profile" 0 "${qwen_options[@]}"
        local qwen_choice=$MENU_RESULT

        case "$qwen_choice" in
            0)
                QWEN_BASE_VARIANT="base-0.6b"
                QWEN_CUSTOM_VARIANT="custom-voice"
                ;;
            1)
                QWEN_BASE_VARIANT="base-1.7b"
                QWEN_CUSTOM_VARIANT="custom-voice"
                ;;
            2)
                QWEN_BASE_VARIANT="base-0.6b"
                QWEN_CUSTOM_VARIANT="custom-voice-0.6b"
                ;;
            *)
                QWEN_BASE_VARIANT="base-0.6b"
                QWEN_CUSTOM_VARIANT="custom-voice"
                ;;
        esac

        QWEN_VARIANT="$QWEN_BASE_VARIANT"
        print_success "Qwen3-TTS MLX profile: Base $QWEN_BASE_VARIANT + CustomVoice $QWEN_CUSTOM_VARIANT"
    fi
    echo ""
    local stt_options=(
        "Parakeet TDT v3 (fast batch + live WebSocket, 25 languages) - Recommended"
        "Qwen3-ASR 0.6B (30 languages, auto detection, forced alignment)"
        "MOSS Transcribe-Diarize 0.9B (English/Chinese, built-in speakers) - Experimental"
    )

    show_checkbox_menu "Select Speech-to-Text Engines" "1 0 0" "${stt_options[@]}"
    IFS=' ' read -ra stt_selected <<< "$MENU_RESULT"
    ENABLE_PARAKEET=${stt_selected[0]}
    ENABLE_QWEN_ASR=${stt_selected[1]}
    ENABLE_MOSS_TD=${stt_selected[2]}

    [ "$ENABLE_PARAKEET" = "1" ] && print_success "Parakeet (batch + realtime STT) enabled"
    [ "$ENABLE_QWEN_ASR" = "1" ] && print_success "Qwen3-ASR + ForcedAligner enabled"
    [ "$ENABLE_MOSS_TD" = "1" ] && print_success "MOSS Transcribe-Diarize enabled (experimental)"
    if [ "$ENABLE_PARAKEET" != "1" ] && [ "$ENABLE_QWEN_ASR" != "1" ] && [ "$ENABLE_MOSS_TD" != "1" ]; then
        print_warning "No speech-to-text engine selected; transcription will be unavailable."
    fi

    if [ "$ENABLE_PARAKEET" = "1" ] || [ "$ENABLE_QWEN_ASR" = "1" ]; then
        echo ""
        local diarization_options=(
            "Skip speaker identification (can be enabled later) - Recommended"
            "Enable pyannote Community-1 speaker identification"
        )

        show_radio_menu "Enable speaker identification?" 0 "${diarization_options[@]}"
        local diarization_choice=$MENU_RESULT
        if [ "$diarization_choice" = "1" ]; then
            ENABLE_DIARIZATION=1
            print_success "pyannote Community-1 speaker identification enabled"
        else
            ENABLE_DIARIZATION=0
            print_info "Speaker identification disabled"
        fi
    else
        ENABLE_DIARIZATION=0
    fi

    echo ""
    echo "Enabled TTS Engines:"
    if [ "$ENABLE_POCKET" = "1" ]; then
        echo -e "  ${CHECK} Pocket TTS"
    else
        echo -e "  ${CROSS} Pocket TTS (disabled)"
    fi
    if [ "$ENABLE_KOKORO" = "1" ]; then
        echo -e "  ${CHECK} Kokoro TTS"
    else
        echo -e "  ${CROSS} Kokoro TTS (disabled)"
    fi
    if [ "$ENABLE_QWEN" = "1" ]; then
        echo -e "  ${CHECK} Qwen3-TTS MLX (Base $QWEN_BASE_VARIANT + CustomVoice $QWEN_CUSTOM_VARIANT)"
    else
        echo -e "  ${CROSS} Qwen3-TTS (disabled)"
    fi
    if [ "$ENABLE_MOSS" = "1" ]; then
        echo -e "  ${CHECK} MOSS-TTS-Nano"
    else
        echo -e "  ${CROSS} MOSS-TTS-Nano (disabled)"
    fi
    if [ "$ENABLE_FISH" = "1" ]; then
        echo -e "  ${CHECK} Fish S2 Pro (8-bit MLX, expressive + cloning — non-commercial)"
    else
        echo -e "  ${CROSS} Fish S2 Pro (disabled)"
    fi
    echo ""
    echo "Transcription:"
    if [ "$ENABLE_PARAKEET" = "1" ]; then
        echo -e "  ${CHECK} Parakeet (batch + realtime STT)"
    else
        echo -e "  ${CROSS} Parakeet (STT) (disabled)"
    fi
    if [ "$ENABLE_QWEN_ASR" = "1" ]; then
        echo -e "  ${CHECK} Qwen3-ASR + ForcedAligner"
    else
        echo -e "  ${CROSS} Qwen3-ASR + ForcedAligner (disabled)"
    fi
    if [ "$ENABLE_MOSS_TD" = "1" ]; then
        echo -e "  ${CHECK} MOSS Transcribe-Diarize (experimental)"
    else
        echo -e "  ${CROSS} MOSS Transcribe-Diarize (disabled)"
    fi
    if [ "$ENABLE_DIARIZATION" = "1" ]; then
        echo -e "  ${CHECK} pyannote Community-1 speaker identification"
    else
        echo -e "  ${CROSS} Speaker identification (disabled)"
    fi

    echo ""
}

################################################################################
# Environment Configuration
################################################################################

configure_environment() {
    print_header "Step 3: Configure Environment"

    # Check if .env exists
    if [ -f .env ]; then
        print_warning ".env file already exists"
        echo ""

        local reconfigure_options=(
            "Keep existing .env (skip configuration)"
            "Reconfigure .env (backup will be created)"
        )

        show_radio_menu "What would you like to do?" 0 "${reconfigure_options[@]}"
        local reconfigure_choice=$MENU_RESULT

        if [ "$reconfigure_choice" = "1" ]; then
            local timestamp=$(date +%Y%m%d_%H%M%S)
            local backup_file=".env.backup.$timestamp"
            cp .env "$backup_file"
            print_success "Backed up existing .env to $backup_file"
            RECONFIGURE=true
        else
            print_info "Keeping existing .env file"
            RECONFIGURE=false
        fi
    else
        if [ ! -f .env.example ]; then
            print_error ".env.example not found"
            exit 1
        fi
        cp .env.example .env
        print_success "Created .env from .env.example"
        RECONFIGURE=true
    fi

    # Update engine flags (apply selections even if keeping existing .env)
    if [ "$ENABLE_KOKORO" = "1" ]; then
        upsert_env_key "TTS_ENABLED" "1"
    else
        upsert_env_key "TTS_ENABLED" "0"
    fi

    if [ "$ENABLE_POCKET" = "1" ]; then
        upsert_env_key "POCKET_TTS_ENABLED" "1"
    else
        upsert_env_key "POCKET_TTS_ENABLED" "0"
    fi

    if [ "$ENABLE_QWEN" = "1" ]; then
        upsert_env_key "QWEN_TTS_ENABLED" "1"
    else
        upsert_env_key "QWEN_TTS_ENABLED" "0"
    fi

    if [ "$ENABLE_MOSS" = "1" ]; then
        upsert_env_key "MOSS_TTS_ENABLED" "1"
        upsert_env_key "MOSS_TTS_MODEL_ID" "mlx-community/MOSS-TTS-Nano-100M"
        upsert_env_key "MOSS_TTS_PYTHON_PATH" "./.venv-moss-tts/bin/python3"
    else
        upsert_env_key "MOSS_TTS_ENABLED" "0"
    fi

    if [ "$ENABLE_FISH" = "1" ]; then
        upsert_env_key "FISH_TTS_ENABLED" "1"
        upsert_env_key "FISH_TTS_PYTHON_PATH" "./.venv-fish-tts/bin/python3"
        upsert_env_key "FISH_TTS_MAX_TOKENS" "1024"
    else
        upsert_env_key "FISH_TTS_ENABLED" "0"
    fi

    if [ "$ENABLE_PARAKEET" = "1" ]; then
        upsert_env_key "TRANSCRIPTION_ENABLED" "1"
        upsert_env_key "PARAKEET_MODEL_ID" "mlx-community/parakeet-tdt-0.6b-v3"
        upsert_env_key "PARAKEET_MODEL_REVISION" "ed2b7e8c15f9aaa0b5772e2efb986255eaef7e15"
        upsert_env_key "PARAKEET_PYTHON_PATH" "./.venv/bin/python3"
        upsert_env_key "PARAKEET_REALTIME_ENABLED" "1"
    else
        upsert_env_key "TRANSCRIPTION_ENABLED" "0"
        upsert_env_key "PARAKEET_REALTIME_ENABLED" "0"
    fi

    if [ "$ENABLE_QWEN_ASR" = "1" ]; then
        upsert_env_key "QWEN_ASR_ENABLED" "1"
        upsert_env_key "QWEN_ASR_MODEL_ID" "mlx-community/Qwen3-ASR-0.6B-8bit"
        upsert_env_key "QWEN_ASR_ALIGNER_MODEL_ID" "mlx-community/Qwen3-ForcedAligner-0.6B-8bit"
    else
        upsert_env_key "QWEN_ASR_ENABLED" "0"
    fi

    if [ "$ENABLE_MOSS_TD" = "1" ]; then
        upsert_env_key "MOSS_TD_ENABLED" "1"
        upsert_env_key "MOSS_TD_MODEL_ID" "OpenMOSS-Team/MOSS-Transcribe-Diarize"
        upsert_env_key "MOSS_TD_MODEL_REVISION" "d7231bbae2587a4af278735eb765b318c4f64edd"
        upsert_env_key "MOSS_TD_PACKAGE_REVISION" "b5ad0f8386b155ddb89f9332ba3ca71891900357"
        upsert_env_key "MOSS_TD_PYTHON_PATH" "./.venv-moss-transcribe/bin/python3"
    else
        upsert_env_key "MOSS_TD_ENABLED" "0"
    fi

    if [ "$ENABLE_DIARIZATION" = "1" ]; then
        upsert_env_key "DIARIZATION_ENABLED" "1"
        upsert_env_key "DIARIZATION_MODEL_ID" "pyannote/speaker-diarization-community-1"
    else
        upsert_env_key "DIARIZATION_ENABLED" "0"
    fi

    # Update Qwen variant if enabled
    if [ "$ENABLE_QWEN" = "1" ]; then
        # Keep the legacy key for rollback while the service uses the explicit
        # multi-daemon model keys below.
        upsert_env_key "QWEN_TTS_MODEL_VARIANT" "$QWEN_VARIANT"
        upsert_env_key "QWEN_TTS_BASE_MODEL" "$QWEN_BASE_VARIANT"
        upsert_env_key "QWEN_TTS_CUSTOM_VOICE_MODEL" "$QWEN_CUSTOM_VARIANT"
        upsert_env_key "QWEN_TTS_VOICE_DESIGN_MODEL" "voice-design"
        upsert_env_key "QWEN_TTS_PYTHON_PATH" "./.venv-qwen-tts/bin/python3"
        upsert_env_key "QWEN_TTS_MLX_PRECISION" "8bit"
        upsert_env_key "QWEN_TTS_DEFAULT_VOICE" "Ryan"
    fi

    # Clean up backup files
    rm -f .env.bak

    print_success "Updated .env configuration"

    if [ "$NON_INTERACTIVE" != "1" ]; then
        echo ""
        read -p "Press Enter to continue..."
    fi
}

################################################################################
# API Key Setup
################################################################################

setup_api_key() {
    print_header "Step 4: API Key Setup"

    if [ "$NON_INTERACTIVE" = "1" ]; then
        # Localhost default: no authentication
        upsert_env_key "AUTH_ENABLED" "0"
        # Keep AUTH_API_KEY untouched if present; AUTH is disabled anyway.
        rm -f .env.bak
        print_info "Non-interactive mode: authentication disabled (localhost use)"
        return
    fi

    if [ "$RECONFIGURE" = false ]; then
        print_info "Keeping existing .env (authentication settings can still be updated)"
    fi

    local auth_options=(
        "No authentication (local use only) - Recommended"
        "Autogenerate API key"
        "Enter my own API key"
    )

    show_radio_menu "API Key Authentication" 0 "${auth_options[@]}"
    local auth_choice=$MENU_RESULT

    case "$auth_choice" in
        0)
            # No authentication
            if grep -q "^AUTH_ENABLED=" .env 2>/dev/null; then
                sed -i.bak "s/^AUTH_ENABLED=.*/# AUTH_ENABLED=0/" .env
                rm -f .env.bak
            fi
            print_info "API key authentication disabled (local use only)"
            ;;
        1)
            # Autogenerate
            local generated_key="sk_$(openssl rand -hex 32)"

            upsert_env_key "AUTH_ENABLED" "1"
            upsert_env_key "AUTH_API_KEY" "$generated_key"

            rm -f .env.bak

            echo ""
            print_success "Generated API key: ${CYAN}$generated_key${NC}"
            print_warning "SAVE THIS KEY - it will not be shown again!"
            ;;
        2)
            # Enter own key
            echo ""
            read -p "Enter your API key: " api_key
            if [ -z "$api_key" ]; then
                print_error "API key cannot be empty"
                exit 1
            fi

            upsert_env_key "AUTH_ENABLED" "1"
            upsert_env_key "AUTH_API_KEY" "$api_key"

            rm -f .env.bak
            print_success "API key authentication enabled"
            ;;
    esac

    echo ""
    read -p "Press Enter to continue..."
}

################################################################################
# Install Dependencies
################################################################################

install_dependencies() {
    print_header "Step 5: Install Dependencies"

    # Node.js dependencies
    if [ -d node_modules ]; then
        if [ "$NON_INTERACTIVE" = "1" ]; then
            print_info "node_modules/ exists; non-interactive mode keeps existing dependencies"
        else
            echo ""
            local npm_options=(
                "Skip (use existing node_modules)"
                "Reinstall dependencies"
            )

            show_radio_menu "node_modules/ already exists" 0 "${npm_options[@]}"
            local npm_choice=$MENU_RESULT

            if [ "$npm_choice" = "1" ]; then
                print_info "Removing node_modules/..."
                rm -rf node_modules
                print_info "Running npm install..."
                npm install
                print_success "Node.js dependencies installed"
            else
                print_info "Skipping npm install"
            fi
        fi
    else
        print_info "Running npm install..."
        npm install
        print_success "Node.js dependencies installed"
    fi

    # Python virtual environment
    if [ -d .venv ] && ! venv_is_healthy; then
        local venv_backup=".venv.backup.$(date +%Y%m%d_%H%M%S)"
        print_warning "Existing .venv is incompatible or broken; moving it to $venv_backup"
        mv .venv "$venv_backup"
    fi

    if [ ! -d .venv ]; then
        print_info "Creating Python virtual environment at .venv/..."
        uv venv --seed --python "$PYTHON_CMD" .venv
        print_success "Python virtual environment created"
    else
        print_info "Python virtual environment already exists at .venv/"
    fi

    # Activate venv and install base dependencies
    print_info "Installing base Python dependencies..."
    source .venv/bin/activate
    pip install --quiet --upgrade pip

    # Install parakeet-mlx if transcription is enabled
    if [ "$ENABLE_PARAKEET" = "1" ]; then
        print_info "Installing pinned parakeet-mlx 0.5.2 for batch and realtime transcription..."
        uv pip install --python .venv/bin/python "parakeet-mlx==0.5.2"
        print_success "parakeet-mlx 0.5.2 is ready"
    else
        print_info "Skipping parakeet-mlx (transcription disabled)"
    fi

    # Install mlx-audio if Kokoro TTS is enabled
    if [ "$ENABLE_KOKORO" = "1" ]; then
        if ! pip show mlx-audio >/dev/null 2>&1; then
            print_info "Installing mlx-audio for Kokoro TTS..."
            pip install --quiet "mlx-audio>=0.2.10,<0.3"
            print_success "mlx-audio installed"
        else
            print_info "mlx-audio already installed"
        fi
    fi

    # Install Pocket TTS dependencies if enabled
    if [ "$ENABLE_POCKET" = "1" ]; then
        if ! pip show pocket-tts >/dev/null 2>&1; then
            print_info "Installing pocket-tts..."
            pip install --quiet pocket-tts scipy
            print_success "pocket-tts installed"
        else
            print_info "pocket-tts already installed"
        fi
    fi

    # Install pyannote Community-1 dependencies if diarization is enabled.
    if [ "$ENABLE_DIARIZATION" = "1" ]; then
        print_info "Ensuring pyannote.audio 4.x is installed for speaker identification..."
        pip install --quiet "pyannote.audio>=4,<5"
        print_success "pyannote.audio 4.x is ready"
    fi

    deactivate

    # Qwen3-TTS uses the current MLX-Audio stack. Keep it isolated from the
    # older Kokoro environment and pin the exact backend tested by this repo.
    if [ "$ENABLE_QWEN" = "1" ]; then
        if [ -d .venv-qwen-tts ] && ! .venv-qwen-tts/bin/python -c "import pip" >/dev/null 2>&1; then
            local qwen_tts_backup=".venv-qwen-tts.backup.$(date +%Y%m%d_%H%M%S)"
            print_warning "Existing Qwen3-TTS environment is broken; moving it to $qwen_tts_backup"
            mv .venv-qwen-tts "$qwen_tts_backup"
        fi

        if [ ! -d .venv-qwen-tts ]; then
            print_info "Creating isolated Qwen3-TTS environment at .venv-qwen-tts/..."
            uv venv --seed --python 3.11 .venv-qwen-tts
        fi

        print_info "Installing pinned MLX-Audio 0.4.5 for Qwen3-TTS..."
        uv pip install --python .venv-qwen-tts/bin/python "mlx-audio==0.4.5"
        uv pip check --python .venv-qwen-tts/bin/python
        print_success "Qwen3-TTS MLX environment is ready"
    fi

    # Qwen3-ASR needs the current MLX-Audio stack, while Kokoro intentionally
    # remains on the older tested version in .venv. Keep those dependencies
    # isolated so enabling ASR cannot destabilize existing TTS providers.
    if [ "$ENABLE_QWEN_ASR" = "1" ]; then
        if [ -d .venv-qwen-asr ] && ! .venv-qwen-asr/bin/python -c "import pip" >/dev/null 2>&1; then
            local qwen_asr_backup=".venv-qwen-asr.backup.$(date +%Y%m%d_%H%M%S)"
            print_warning "Existing Qwen3-ASR environment is broken; moving it to $qwen_asr_backup"
            mv .venv-qwen-asr "$qwen_asr_backup"
        fi

        if [ ! -d .venv-qwen-asr ]; then
            print_info "Creating isolated Qwen3-ASR environment at .venv-qwen-asr/..."
            # Python 3.11 has wheels for MLX-Audio and the Japanese/Korean
            # alignment tokenizers. uv downloads it when it is not installed.
            uv venv --seed --python 3.11 .venv-qwen-asr
        fi

        print_info "Installing MLX-Audio 0.4.x and alignment tokenizers for Qwen3-ASR..."
        uv pip install --python .venv-qwen-asr/bin/python \
            "mlx-audio>=0.4.5,<0.5" nagisa soynlp
        print_success "Qwen3-ASR environment is ready"
    fi

    # MOSS-TTS-Nano uses the current MLX-Audio stack and stays isolated from
    # both the legacy Kokoro environment and Qwen3-ASR lifecycle.
    if [ "$ENABLE_MOSS" = "1" ]; then
        if [ -d .venv-moss-tts ] && ! .venv-moss-tts/bin/python -c "import pip" >/dev/null 2>&1; then
            local moss_backup=".venv-moss-tts.backup.$(date +%Y%m%d_%H%M%S)"
            print_warning "Existing MOSS-TTS-Nano environment is broken; moving it to $moss_backup"
            mv .venv-moss-tts "$moss_backup"
        fi

        if [ ! -d .venv-moss-tts ]; then
            print_info "Creating isolated MOSS-TTS-Nano environment at .venv-moss-tts/..."
            uv venv --seed --python 3.11 .venv-moss-tts
        fi

        print_info "Installing MLX-Audio 0.4.x for MOSS-TTS-Nano..."
        uv pip install --python .venv-moss-tts/bin/python "mlx-audio>=0.4.5,<0.5"
        print_success "MOSS-TTS-Nano environment is ready"
    fi

    # Fish S2 Pro (8-bit MLX) — expressive TTS + zero-shot voice cloning.
    # NON-COMMERCIAL (Fish Audio Research License): local evaluation only. Uses a
    # vendored community MLX inference repo + a pre-quantized 8-bit checkpoint,
    # both git-ignored. Pins transformers==4.56.1 (the mlx-audio fish branch
    # declares transformers>=5 but ships mlx-lm 0.31.1, which needs <5).
    if [ "$ENABLE_FISH" = "1" ]; then
        if [ -d .venv-fish-tts ] && ! .venv-fish-tts/bin/python -c "import pip" >/dev/null 2>&1; then
            local fish_backup=".venv-fish-tts.backup.$(date +%Y%m%d_%H%M%S)"
            print_warning "Existing Fish S2 environment is broken; moving it to $fish_backup"
            mv .venv-fish-tts "$fish_backup"
        fi

        if [ ! -d .venv-fish-tts ]; then
            print_info "Creating isolated Fish S2 environment at .venv-fish-tts/..."
            uv venv --seed --python 3.11 .venv-fish-tts
        fi

        print_info "Installing mlx-audio (fish-audio-s2 branch) + deps for Fish S2..."
        uv pip install --python .venv-fish-tts/bin/python \
            "git+https://github.com/lucasnewman/mlx-audio.git@fish-audio-s2" \
            soundfile numpy scipy huggingface_hub
        # The fish branch declares transformers>=5 but mlx-lm 0.31.1 needs <5.
        uv pip install --python .venv-fish-tts/bin/python "transformers==4.56.1" "tokenizers==0.22.0"

        if [ ! -d vendor/fish-s2-mlx/local_mlx ]; then
            print_info "Vendoring the Fish S2 MLX inference repo (git-ignored, non-commercial)..."
            mkdir -p vendor
            git clone --depth 1 https://github.com/groxaxo/fish-s2-pro-mlx-local-deploy vendor/fish-s2-mlx
            rm -rf vendor/fish-s2-mlx/.git
        fi

        if [ ! -d checkpoints/fish-audio-s2-pro-8bit-mlx-normalized ]; then
            print_warning "Downloading the Fish S2 8-bit checkpoint (~6.7 GB) — this can take a while."
            mkdir -p checkpoints
            if [ ! -f checkpoints/fish-audio-s2-pro-8bit-mlx/model.safetensors ]; then
                .venv-fish-tts/bin/huggingface-cli download cs2764/fish-audio-s2-pro-8bit-mlx \
                    --local-dir checkpoints/fish-audio-s2-pro-8bit-mlx
            fi
            print_info "Normalizing the checkpoint for the mlx-audio fish branch..."
            PYTHONPATH="$PWD/vendor/fish-s2-mlx" .venv-fish-tts/bin/python \
                vendor/fish-s2-mlx/local_mlx/normalize_cs2764_checkpoint.py \
                checkpoints/fish-audio-s2-pro-8bit-mlx \
                checkpoints/fish-audio-s2-pro-8bit-mlx-normalized
        fi
        print_success "Fish S2 Pro environment is ready (non-commercial — evaluation only)"
    fi

    # MOSS Transcribe-Diarize depends on Transformers 5.x and PyTorch. Keep it
    # isolated, pin both source revisions, and use the tested Apple Silicon
    # runtime so this experimental option cannot disturb the other engines.
    if [ "$ENABLE_MOSS_TD" = "1" ]; then
        if [ -d .venv-moss-transcribe ] && ! .venv-moss-transcribe/bin/python -c "import pip" >/dev/null 2>&1; then
            local moss_td_backup=".venv-moss-transcribe.backup.$(date +%Y%m%d_%H%M%S)"
            print_warning "Existing MOSS Transcribe-Diarize environment is broken; moving it to $moss_td_backup"
            mv .venv-moss-transcribe "$moss_td_backup"
        fi

        if [ ! -d .venv-moss-transcribe ]; then
            print_info "Creating isolated MOSS Transcribe-Diarize environment at .venv-moss-transcribe/..."
            uv venv --seed --python 3.12 .venv-moss-transcribe
        fi

        print_info "Installing pinned experimental MOSS Transcribe-Diarize runtime..."
        uv pip install --python .venv-moss-transcribe/bin/python --torch-backend=auto \
            "torch==2.11.0" \
            "torchaudio==2.11.0" \
            "moss-transcribe-diarize @ git+https://github.com/OpenMOSS/MOSS-Transcribe-Diarize.git@b5ad0f8386b155ddb89f9332ba3ca71891900357"
        uv pip check --python .venv-moss-transcribe/bin/python
        print_success "MOSS Transcribe-Diarize environment is ready"
    fi

    print_success "All dependencies installed"

    if [ "$NON_INTERACTIVE" != "1" ]; then
        echo ""
        read -p "Press Enter to continue..."
    fi
}

################################################################################
# Pocket TTS Voice Cloning Access
################################################################################

setup_pocket_voice_cloning() {
    if [ "$ENABLE_POCKET" != "1" ]; then
        return
    fi

    print_header "Step 6: Pocket TTS Voice Cloning Access"

    if [ "$NON_INTERACTIVE" = "1" ]; then
        POCKET_CLONE_READY=0
        print_info "Non-interactive mode: skipping Hugging Face login for voice cloning"
        print_warning "To use Pocket voice cloning later, create a free Hugging Face account, accept the Pocket TTS model terms, then run: uvx hf auth login"
        print_info "You can run ./setup.sh interactively anytime to configure this"
        return
    fi

    echo "Pocket TTS voice cloning requires extra access to download cloning weights."
    echo "To use the default project voice clone (or create new clones), complete:"
    echo ""
    echo "  1) Accept the terms here:"
    echo "     https://huggingface.co/kyutai/pocket-tts"
    echo "  2) Log in locally:"
    echo "     uvx hf auth login"
    echo ""

    POCKET_CLONE_READY=0

    if [ -n "${HF_TOKEN:-}" ]; then
        print_success "HF_TOKEN is set. Voice cloning downloads should work."
        POCKET_CLONE_READY=1
    elif [ -f "$HOME/.cache/huggingface/token" ] || [ -f "$HOME/.huggingface/token" ]; then
        print_success "Hugging Face token detected on disk."
        POCKET_CLONE_READY=1
    else
        local clone_options=(
            "Run 'uvx hf auth login' now"
            "I will log in later (voice cloning will be unavailable)"
        )

        show_radio_menu "Log in to Hugging Face now?" 0 "${clone_options[@]}"
        local clone_choice=$MENU_RESULT

        if [ "$clone_choice" = "0" ]; then
            print_info "Launching Hugging Face login..."
            if uvx hf auth login; then
                if [ -n "${HF_TOKEN:-}" ] || [ -f "$HOME/.cache/huggingface/token" ] || [ -f "$HOME/.huggingface/token" ]; then
                    print_success "Hugging Face login complete."
                    POCKET_CLONE_READY=1
                else
                    print_warning "Login finished, but no token was detected."
                fi
            else
                print_warning "Hugging Face login did not complete."
            fi
        else
            print_warning "Skipping Hugging Face login. Voice cloning will fail until you log in."
        fi
    fi

    echo ""
    read -p "Press Enter to continue..."
}

################################################################################
# pyannote Community-1 Access
################################################################################

setup_diarization_access() {
    if [ "$ENABLE_DIARIZATION" != "1" ]; then
        return
    fi

    print_header "Step 7: pyannote Community-1 Access"

    echo "Speaker identification uses a gated, locally downloaded model."
    echo "Accept its terms here:"
    echo "  https://huggingface.co/pyannote/speaker-diarization-community-1"
    echo ""

    if [ "$NON_INTERACTIVE" = "1" ]; then
        print_warning "Non-interactive mode cannot accept gated model terms."
        print_info "Accept the terms and run: uvx hf auth login"
        return
    fi

    read -p "Press Enter after accepting the model terms..."

    if huggingface_credentials_available; then
        print_success "Hugging Face credentials detected."
    else
        local login_options=(
            "Run 'uvx hf auth login' now"
            "I will log in later (speaker identification will be unavailable)"
        )
        show_radio_menu "Log in to Hugging Face now?" 0 "${login_options[@]}"
        if [ "$MENU_RESULT" = "0" ]; then
            print_info "Launching Hugging Face login..."
            if uvx hf auth login && huggingface_credentials_available; then
                print_success "Hugging Face login complete."
            else
                print_warning "No Hugging Face credentials were detected."
            fi
        else
            print_warning "Speaker identification will fail until Hugging Face access is configured."
        fi
    fi

    echo ""
    read -p "Press Enter to continue..."
}

################################################################################
# Predownload Models
################################################################################

predownload_qwen_asr_models() {
    if [ "$ENABLE_QWEN_ASR" != "1" ]; then
        return
    fi

    print_info "Predownloading Qwen3-ASR and ForcedAligner (~2.2 GB total)..."
    if .venv-qwen-asr/bin/python - <<'PY'
import os
from pathlib import Path
from mlx_audio.stt import load

def configured_value(key, default):
    if os.environ.get(key):
        return os.environ[key]
    env_file = Path(".env")
    if env_file.is_file():
        for line in env_file.read_text().splitlines():
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip() or default
    return default

asr_model = configured_value(
    "QWEN_ASR_MODEL_ID", "mlx-community/Qwen3-ASR-0.6B-8bit"
)
aligner_model = configured_value(
    "QWEN_ASR_ALIGNER_MODEL_ID",
    "mlx-community/Qwen3-ForcedAligner-0.6B-8bit",
)

load(asr_model)
load(aligner_model)
PY
    then
        print_success "Qwen3-ASR and ForcedAligner downloaded"
    else
        print_warning "Qwen3-ASR model predownload failed; the server will retry on first use"
    fi
}

predownload_qwen_tts_models() {
    if [ "$ENABLE_QWEN" != "1" ]; then
        return
    fi

    print_info "Predownloading pinned Qwen3-TTS MLX Base and CustomVoice models..."
    if QWEN_TTS_BASE_MODEL="$QWEN_BASE_VARIANT" \
        QWEN_TTS_CUSTOM_VOICE_MODEL="$QWEN_CUSTOM_VARIANT" \
        QWEN_TTS_MLX_PRECISION="8bit" \
        .venv-qwen-tts/bin/python - <<'PY'
import importlib.util
import os
from pathlib import Path

from huggingface_hub import snapshot_download

daemon_path = Path("scripts/qwen_tts_daemon.py").resolve()
spec = importlib.util.spec_from_file_location("qwen_tts_daemon", daemon_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

precision = os.environ.get("QWEN_TTS_MLX_PRECISION", "8bit")
variants = [
    os.environ["QWEN_TTS_BASE_MODEL"],
    os.environ["QWEN_TTS_CUSTOM_VOICE_MODEL"],
]
for variant in variants:
    try:
        repo, revision = module.MODEL_VARIANTS[variant]["models"][precision]
    except KeyError as exc:
        raise RuntimeError(
            f"Unsupported Qwen3-TTS model selection: {variant}/{precision}"
        ) from exc
    print(f"Downloading {variant}: {repo}@{revision}")
    snapshot_download(repo_id=repo, revision=revision)
PY
    then
        print_success "Pinned Qwen3-TTS Base and CustomVoice models downloaded"
        print_info "VoiceDesign remains lazy and downloads on its first request"
    else
        print_warning "Qwen3-TTS model predownload failed; the server will retry on first use"
    fi
}

predownload_moss_tts_model() {
    if [ "$ENABLE_MOSS" != "1" ]; then
        return
    fi

    print_info "Predownloading MOSS-TTS-Nano and its audio tokenizer (~360 MB total)..."
    if .venv-moss-tts/bin/python - <<'PY'
import os
from pathlib import Path
from huggingface_hub import snapshot_download
from mlx_audio.tts import load

def configured_value(key, default):
    if os.environ.get(key):
        return os.environ[key]
    env_file = Path(".env")
    if env_file.is_file():
        for line in env_file.read_text().splitlines():
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip() or default
    return default

model = load(configured_value(
    "MOSS_TTS_MODEL_ID",
    "mlx-community/MOSS-TTS-Nano-100M",
))
snapshot_download(repo_id=model.config.audio_tokenizer_pretrained_name_or_path)
PY
    then
        print_success "MOSS-TTS-Nano and audio tokenizer downloaded"
    else
        print_warning "MOSS-TTS-Nano predownload failed; the server will retry on first use"
    fi
}

predownload_moss_td_model() {
    if [ "$ENABLE_MOSS_TD" != "1" ]; then
        return
    fi

    print_info "Predownloading pinned MOSS Transcribe-Diarize model (~1.8 GB)..."
    if .venv-moss-transcribe/bin/python - <<'PY'
import os
from pathlib import Path

import torch
from moss_transcribe_diarize import (
    MossTranscribeDiarizeForConditionalGeneration,
    MossTranscribeDiarizeProcessor,
)


def configured_value(key, default):
    if os.environ.get(key):
        return os.environ[key]
    env_file = Path(".env")
    if env_file.is_file():
        for line in env_file.read_text().splitlines():
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip() or default
    return default


model_id = configured_value(
    "MOSS_TD_MODEL_ID", "OpenMOSS-Team/MOSS-Transcribe-Diarize"
)
revision = configured_value(
    "MOSS_TD_MODEL_REVISION", "d7231bbae2587a4af278735eb765b318c4f64edd"
)
MossTranscribeDiarizeProcessor.from_pretrained(
    model_id,
    revision=revision,
    trust_remote_code=False,
    fix_mistral_regex=True,
)
MossTranscribeDiarizeForConditionalGeneration.from_pretrained(
    model_id,
    revision=revision,
    dtype=torch.float16,
    trust_remote_code=False,
)
PY
    then
        print_success "Pinned MOSS Transcribe-Diarize model downloaded and verified"
    else
        print_warning "MOSS Transcribe-Diarize predownload failed; the server will retry on first use"
    fi
}

predownload_models() {
    print_header "Step 8: Predownload Models"

    if [ "$NON_INTERACTIVE" = "1" ]; then
        PRELOAD_MODELS=true
        print_info "Non-interactive mode: predownloading enabled models now (Pocket TTS + Parakeet)"
        print_info "This keeps first requests fast by avoiding cold-start downloads"

        source .venv/bin/activate

        export ENABLE_PARAKEET
        export ENABLE_KOKORO
        export ENABLE_POCKET
        export ENABLE_DIARIZATION

        python - <<'PY'
import os
import sys
import traceback
from importlib.util import spec_from_file_location, module_from_spec
from pathlib import Path

ROOT = Path.cwd()

def load_module(path: Path, name: str):
    spec = spec_from_file_location(name, str(path))
    mod = module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[attr-defined]
    return mod

def run_step(title, fn):
    print(f"\n==> {title}")
    try:
        fn()
        print(f"==> {title}: done")
        return True
    except Exception as exc:
        print(f"==> {title}: failed ({exc})", file=sys.stderr)
        traceback.print_exc()
        return False

def download_parakeet():
    from huggingface_hub import snapshot_download
    from parakeet_mlx import from_pretrained
    model_path = snapshot_download(
        repo_id="mlx-community/parakeet-tdt-0.6b-v3",
        revision="ed2b7e8c15f9aaa0b5772e2efb986255eaef7e15",
    )
    from_pretrained(model_path)

def download_kokoro():
    tts_path = ROOT / "scripts" / "tts_daemon.py"
    tts_mod = load_module(tts_path, "tts_daemon")
    from huggingface_hub import snapshot_download
    model_path = Path(tts_mod.MODEL_PATH)
    snapshot_download(tts_mod.MODEL_REPO, local_dir=str(model_path))

def download_pocket():
    from pocket_tts import TTSModel
    TTSModel.load_model()

def download_diarization():
    from pyannote.audio import Pipeline
    model_id = os.environ.get(
        "DIARIZATION_MODEL_ID",
        "pyannote/speaker-diarization-community-1",
    )
    token = os.environ.get("HF_TOKEN")
    if not token and (ROOT / ".env").is_file():
        for line in (ROOT / ".env").read_text().splitlines():
            if line.startswith("HF_TOKEN="):
                token = line.split("=", 1)[1].strip()
                break
    Pipeline.from_pretrained(model_id, token=token or True)

enable_parakeet = os.environ.get("ENABLE_PARAKEET") == "1"
enable_kokoro = os.environ.get("ENABLE_KOKORO") == "1"
enable_pocket = os.environ.get("ENABLE_POCKET") == "1"
enable_diarization = os.environ.get("ENABLE_DIARIZATION") == "1"

if enable_parakeet:
    run_step("Parakeet (STT)", download_parakeet)
else:
    print("\n==> Parakeet (STT): skipped (disabled)")

if enable_kokoro:
    run_step("Kokoro (TTS)", download_kokoro)
else:
    print("\n==> Kokoro (TTS): skipped (disabled)")

if enable_pocket:
    run_step("Pocket TTS", download_pocket)
else:
    print("\n==> Pocket TTS: skipped (disabled)")

if enable_diarization:
    run_step("pyannote Community-1", download_diarization)
else:
    print("\n==> pyannote Community-1: skipped (disabled)")
PY

        deactivate
        predownload_qwen_tts_models
        predownload_qwen_asr_models
        predownload_moss_tts_model
        predownload_moss_td_model
        return
    fi

    local predownload_options=(
        "Download models now (recommended)"
        "Skip (download on first request)"
    )

    show_radio_menu "Predownload TTS/STT models?" 0 "${predownload_options[@]}"
    local predownload_choice=$MENU_RESULT

    if [ "$predownload_choice" = "1" ]; then
        PRELOAD_MODELS=false
        print_info "Skipping model downloads. Models will download on first request."
        echo ""
        read -p "Press Enter to continue..."
        return
    fi

    PRELOAD_MODELS=true
    print_info "Downloading models now. This may take several minutes and multiple GB."
    echo ""

    source .venv/bin/activate

    export ENABLE_PARAKEET
    export ENABLE_KOKORO
    export ENABLE_POCKET
    export ENABLE_DIARIZATION

    python - <<'PY'
import os
import sys
import traceback
from importlib.util import spec_from_file_location, module_from_spec
from pathlib import Path

ROOT = Path.cwd()

def load_module(path: Path, name: str):
    spec = spec_from_file_location(name, str(path))
    mod = module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[attr-defined]
    return mod

def run_step(title, fn):
    print(f"\n==> {title}")
    try:
        fn()
        print(f"==> {title}: done")
        return True
    except Exception as exc:
        print(f"==> {title}: failed ({exc})", file=sys.stderr)
        traceback.print_exc()
        return False

def download_parakeet():
    from huggingface_hub import snapshot_download
    from parakeet_mlx import from_pretrained
    model_path = snapshot_download(
        repo_id="mlx-community/parakeet-tdt-0.6b-v3",
        revision="ed2b7e8c15f9aaa0b5772e2efb986255eaef7e15",
    )
    from_pretrained(model_path)

def download_kokoro():
    tts_path = ROOT / "scripts" / "tts_daemon.py"
    tts_mod = load_module(tts_path, "tts_daemon")
    from huggingface_hub import snapshot_download
    model_path = Path(tts_mod.MODEL_PATH)
    snapshot_download(tts_mod.MODEL_REPO, local_dir=str(model_path))

def download_pocket():
    from pocket_tts import TTSModel
    TTSModel.load_model()

def download_diarization():
    from pyannote.audio import Pipeline
    model_id = os.environ.get(
        "DIARIZATION_MODEL_ID",
        "pyannote/speaker-diarization-community-1",
    )
    token = os.environ.get("HF_TOKEN")
    if not token and (ROOT / ".env").is_file():
        for line in (ROOT / ".env").read_text().splitlines():
            if line.startswith("HF_TOKEN="):
                token = line.split("=", 1)[1].strip()
                break
    Pipeline.from_pretrained(model_id, token=token or True)

enable_parakeet = os.environ.get("ENABLE_PARAKEET") == "1"
enable_kokoro = os.environ.get("ENABLE_KOKORO") == "1"
enable_pocket = os.environ.get("ENABLE_POCKET") == "1"
enable_diarization = os.environ.get("ENABLE_DIARIZATION") == "1"

if enable_parakeet:
    run_step("Parakeet (STT)", download_parakeet)
else:
    print("\n==> Parakeet (STT): skipped (disabled)")

if enable_kokoro:
    run_step("Kokoro (TTS)", download_kokoro)
else:
    print("\n==> Kokoro (TTS): skipped (disabled)")

if enable_pocket:
    run_step("Pocket TTS", download_pocket)
else:
    print("\n==> Pocket TTS: skipped (disabled)")

if enable_diarization:
    run_step("pyannote Community-1", download_diarization)
else:
    print("\n==> pyannote Community-1: skipped (disabled)")
PY

    deactivate
    predownload_qwen_tts_models
    predownload_qwen_asr_models
    predownload_moss_tts_model
    predownload_moss_td_model

    echo ""
    read -p "Press Enter to continue..."
}

################################################################################
# Print Summary
################################################################################

print_summary() {
    print_header "Setup Complete!"

    echo "Configuration Summary:"
    echo "────────────────────────────────────────────────────────────────────────────────"
    echo ""

    # Enabled TTS Engines
    echo "Enabled TTS Engines:"
    if [ "$ENABLE_POCKET" = "1" ]; then
        printf '%b\n' "  ${CHECK} Pocket TTS"
    else
        printf '%b\n' "  ${CROSS} Pocket TTS (disabled)"
    fi
    if [ "$ENABLE_KOKORO" = "1" ]; then
        printf '%b\n' "  ${CHECK} Kokoro TTS"
    else
        printf '%b\n' "  ${CROSS} Kokoro TTS (disabled)"
    fi
    if [ "$ENABLE_QWEN" = "1" ]; then
        printf '%b\n' "  ${CHECK} Qwen3-TTS MLX (Base $QWEN_BASE_VARIANT + CustomVoice $QWEN_CUSTOM_VARIANT)"
    else
        printf '%b\n' "  ${CROSS} Qwen3-TTS (disabled)"
    fi
    if [ "$ENABLE_MOSS" = "1" ]; then
        printf '%b\n' "  ${CHECK} MOSS-TTS-Nano"
    else
        printf '%b\n' "  ${CROSS} MOSS-TTS-Nano (disabled)"
    fi
    if [ "$ENABLE_FISH" = "1" ]; then
        printf '%b\n' "  ${CHECK} Fish S2 Pro (8-bit MLX, expressive + cloning)"
    else
        printf '%b\n' "  ${CROSS} Fish S2 Pro (disabled)"
    fi
    echo ""

    # Transcription
    echo "Transcription:"
    if [ "$ENABLE_PARAKEET" = "1" ]; then
        printf '%b\n' "  ${CHECK} Parakeet (batch + realtime STT) enabled"
    else
        printf '%b\n' "  ${CROSS} Parakeet (STT) disabled"
    fi
    if [ "$ENABLE_QWEN_ASR" = "1" ]; then
        printf '%b\n' "  ${CHECK} Qwen3-ASR + ForcedAligner enabled"
    else
        printf '%b\n' "  ${CROSS} Qwen3-ASR + ForcedAligner disabled"
    fi
    if [ "$ENABLE_MOSS_TD" = "1" ]; then
        printf '%b\n' "  ${CHECK} MOSS Transcribe-Diarize enabled (experimental)"
    else
        printf '%b\n' "  ${CROSS} MOSS Transcribe-Diarize disabled"
    fi
    if [ "$ENABLE_DIARIZATION" = "1" ]; then
        printf '%b\n' "  ${CHECK} pyannote Community-1 speaker identification enabled"
    else
        printf '%b\n' "  ${CROSS} Speaker identification disabled"
    fi
    echo ""

    # API Key Status
    echo "Authentication:"
    if grep -q "^AUTH_ENABLED=1" .env 2>/dev/null; then
        printf '%b\n' "  ${CHECK} API key authentication enabled"
    else
        printf '%b\n' "  ${INFO} API key authentication disabled (local use only)"
    fi
    echo ""

    # Model Download Info
    echo "First Run Notes:"
    echo "────────────────────────────────────────────────────────────────────────────────"
    if [ "$PRELOAD_MODELS" = true ]; then
        echo "Models were predownloaded during setup:"
    else
        echo "On first request, models will be automatically downloaded:"
    fi
    echo ""
    echo "  Model               Size        Download Time"
    echo "  ─────────────────── ─────────── ──────────────"
    if [ "$ENABLE_PARAKEET" = "1" ]; then
        echo "  Parakeet (STT)      ~2.5 GB     2-5 minutes"
    fi
    if [ "$ENABLE_QWEN_ASR" = "1" ]; then
        echo "  Qwen3-ASR + aligner ~2.2 GB     2-5 minutes"
    fi
    if [ "$ENABLE_MOSS_TD" = "1" ]; then
        echo "  MOSS Transcribe-Diarize ~1.8 GB  2-5 minutes"
    fi
    if [ "$ENABLE_POCKET" = "1" ]; then
        echo "  Pocket TTS          ~200 MB     30-60 seconds"
    fi
    if [ "$ENABLE_KOKORO" = "1" ]; then
        echo "  Kokoro TTS          ~300 MB     30-60 seconds"
    fi
    if [ "$ENABLE_QWEN" = "1" ]; then
        if [ "$QWEN_BASE_VARIANT" = "base-1.7b" ]; then
            echo "  Qwen3-TTS MLX pair  ~5.8 GB     5-10 minutes"
        elif [ "$QWEN_CUSTOM_VARIANT" = "custom-voice-0.6b" ]; then
            echo "  Qwen3-TTS MLX pair  ~3.8 GB     3-7 minutes"
        else
            echo "  Qwen3-TTS MLX pair  ~4.8 GB     4-8 minutes"
        fi
        echo "  VoiceDesign (lazy)  ~2.9 GB     first request only"
    fi
    if [ "$ENABLE_MOSS" = "1" ]; then
        echo "  MOSS-TTS-Nano     ~360 MB     30-90 seconds"
    fi
    if [ "$ENABLE_DIARIZATION" = "1" ]; then
        echo "  pyannote Community-1 ~70 MB      1-3 minutes"
    fi
    if [ "$ENABLE_POCKET" = "1" ] && [ "${POCKET_CLONE_READY:-0}" != "1" ]; then
        echo ""
        echo "Pocket TTS voice cloning is not enabled yet."
        echo "Complete the steps below before using voice cloning:"
        echo "  https://huggingface.co/kyutai/pocket-tts"
        echo "  uvx hf auth login"
    fi
    echo ""

    # Next Steps
    echo "Next Steps:"
    echo "────────────────────────────────────────────────────────────────────────────────"
    echo ""
    echo "Development:"
    echo "  npm run dev              # Start server with hot reload"
    echo "  npm start                # Start server without hot reload"
    echo ""
    echo "Production (PM2):"
    echo "  npm run pm2:start        # Start with PM2"
    echo "  npm run pm2:logs         # View logs"
    echo "  npm run pm2:stop         # Stop service"
    echo ""
    echo "Testing:"
    echo "  npm test                 # Run tests in watch mode"
    echo "  npm run test:run         # Run tests once"
    echo ""
    echo "Server will run at: http://localhost:3000"
    echo "Health check: curl http://localhost:3000/health"
    echo ""
    echo "────────────────────────────────────────────────────────────────────────────────"
    echo ""
    print_success "Setup complete! You're ready to start the server."
    echo ""
}

################################################################################
# Main Execution
################################################################################

main() {
    if [ "$NON_INTERACTIVE" != "1" ]; then
        clear
    fi
    echo ""
    echo "╔════════════════════════════════════════════════════════════════════════════════╗"
    echo "║                                                                                ║"
    echo "║                     Sogni Voice API - Interactive Setup                       ║"
    echo "║                                                                                ║"
    echo "╚════════════════════════════════════════════════════════════════════════════════╝"
    echo ""

    check_system_requirements
    select_tts_engines
    configure_environment
    setup_api_key
    install_dependencies
    setup_pocket_voice_cloning
    setup_diarization_access
    predownload_models
    print_summary
}

# Run main function
main
