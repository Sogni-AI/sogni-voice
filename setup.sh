#!/bin/bash

################################################################################
# Sogni Voice API - Interactive Setup Script
#
# This script provides one-click setup for the Sogni Voice API, including:
# - System requirements verification
# - TTS engine selection (Kokoro, Pocket, Qwen)
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
    if command -v python3.13 >/dev/null 2>&1; then
        PYTHON_CMD="python3.13"
    elif command -v python3.12 >/dev/null 2>&1; then
        PYTHON_CMD="python3.12"
    elif command -v python3.11 >/dev/null 2>&1; then
        PYTHON_CMD="python3.11"
    elif command -v python3.10 >/dev/null 2>&1; then
        PYTHON_CMD="python3.10"
    elif command -v python3 >/dev/null 2>&1; then
        PYTHON_CMD="python3"
    fi

    if [ -n "$PYTHON_CMD" ]; then
        local python_version=$($PYTHON_CMD --version | awk '{print $2}')
        if version_ge "$python_version" "3.10.0"; then
            print_success "Python $python_version ($PYTHON_CMD) (≥3.10 required)"
        else
            print_error "Python $python_version is too old (≥3.10 required)"
            print_info "Install via: brew install python@3.11"
            all_good=false
        fi
    else
        print_error "Python 3 not found"
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
        ENABLE_PARAKEET=1
        QWEN_VARIANT="base-0.6b"

        print_info "Non-interactive mode: using defaults"
        print_info "- Pocket TTS: enabled"
        print_info "- Kokoro TTS: disabled"
        print_info "- Qwen3-TTS: disabled"
        print_info "- Parakeet STT: enabled"
        return
    fi

    # Checkbox menu for TTS engines
    local tts_options=(
        "Pocket TTS (Fast, CPU-only, 8 English voices, voice cloning) - Recommended"
        "Kokoro TTS (Mid, MLX-based, 32 voices, 4 languages)"
        "Qwen3-TTS (Slow, 11 languages, voice cloning, audio style prompting)"
    )

    # Get selections via global MENU_RESULT (Pocket=yes, Kokoro=no, Qwen=no by default)
    show_checkbox_menu "Select TTS Engines to Enable" "1 0 0" "${tts_options[@]}"
    IFS=' ' read -ra tts_selected <<< "$MENU_RESULT"

    ENABLE_POCKET=${tts_selected[0]}
    ENABLE_KOKORO=${tts_selected[1]}
    ENABLE_QWEN=${tts_selected[2]}

    # If Qwen is enabled, ask for variant
    if [ "$ENABLE_QWEN" = "1" ]; then
        echo ""
        local qwen_options=(
            "base-0.6b (600M params, voice cloning) - Recommended"
            "base-1.7b (1.7B params, voice cloning, higher quality)"
            "custom-voice (600M params, emotion/style control)"
        )

        show_radio_menu "Select Qwen3-TTS Model Variant" 0 "${qwen_options[@]}"
        local qwen_choice=$MENU_RESULT

        case "$qwen_choice" in
            0) QWEN_VARIANT="base-0.6b" ;;
            1) QWEN_VARIANT="base-1.7b" ;;
            2) QWEN_VARIANT="custom-voice" ;;
            *) QWEN_VARIANT="base-0.6b" ;;
        esac

        print_success "Qwen3-TTS variant: $QWEN_VARIANT"
    fi

    echo ""
    local parakeet_options=(
        "Enable Parakeet (STT) for transcription - Recommended"
        "Skip Parakeet (no transcription support)"
    )

    show_radio_menu "Enable Parakeet for speech-to-text?" 0 "${parakeet_options[@]}"
    local parakeet_choice=$MENU_RESULT

    if [ "$parakeet_choice" = "0" ]; then
        ENABLE_PARAKEET=1
        print_success "Parakeet (STT) enabled"
    else
        ENABLE_PARAKEET=0
        print_warning "Parakeet (STT) disabled; transcription endpoints will be unavailable."
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
        echo -e "  ${CHECK} Qwen3-TTS"
    else
        echo -e "  ${CROSS} Qwen3-TTS (disabled)"
    fi
    echo ""
    echo "Transcription:"
    if [ "$ENABLE_PARAKEET" = "1" ]; then
        echo -e "  ${CHECK} Parakeet (STT)"
    else
        echo -e "  ${CROSS} Parakeet (STT) (disabled)"
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

    if [ "$ENABLE_PARAKEET" = "1" ]; then
        upsert_env_key "TRANSCRIPTION_ENABLED" "1"
    else
        upsert_env_key "TRANSCRIPTION_ENABLED" "0"
    fi

    # Update Qwen variant if enabled
    if [ "$ENABLE_QWEN" = "1" ]; then
        upsert_env_key "QWEN_TTS_MODEL_VARIANT" "$QWEN_VARIANT"
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
    if [ ! -d .venv ]; then
        print_info "Creating Python virtual environment at .venv/..."
        $PYTHON_CMD -m venv .venv
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
        if ! pip show parakeet-mlx >/dev/null 2>&1; then
            print_info "Installing parakeet-mlx for transcription..."
            pip install --quiet parakeet-mlx
            print_success "parakeet-mlx installed"
        else
            print_info "parakeet-mlx already installed"
        fi
    else
        print_info "Skipping parakeet-mlx (transcription disabled)"
    fi

    # Install mlx-audio if Kokoro TTS is enabled
    if [ "$ENABLE_KOKORO" = "1" ]; then
        if ! pip show mlx-audio >/dev/null 2>&1; then
            print_info "Installing mlx-audio for Kokoro TTS..."
            pip install --quiet mlx-audio
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

    # Install Qwen TTS dependencies if enabled
    if [ "$ENABLE_QWEN" = "1" ]; then
        if ! pip show qwen-tts >/dev/null 2>&1; then
            print_info "Installing qwen-tts..."
            pip install --quiet qwen-tts
            print_success "qwen-tts installed"
        else
            print_info "qwen-tts already installed"
        fi
    fi

    deactivate
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
# Predownload Models
################################################################################

predownload_models() {
    print_header "Step 7: Predownload Models"

    if [ "$NON_INTERACTIVE" = "1" ]; then
        PRELOAD_MODELS=true
        print_info "Non-interactive mode: predownloading enabled models now (Pocket TTS + Parakeet)"
        print_info "This keeps first requests fast by avoiding cold-start downloads"

        source .venv/bin/activate

        export ENABLE_PARAKEET
        export ENABLE_KOKORO
        export ENABLE_POCKET
        export ENABLE_QWEN

        if [ "$ENABLE_QWEN" = "1" ]; then
            export QWEN_TTS_MODEL_VARIANT="$QWEN_VARIANT"
        fi

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
    from parakeet_mlx import from_pretrained
    from_pretrained("mlx-community/parakeet-tdt-0.6b-v3")

def download_kokoro():
    tts_path = ROOT / "scripts" / "tts_daemon.py"
    tts_mod = load_module(tts_path, "tts_daemon")
    from huggingface_hub import snapshot_download
    model_path = Path(tts_mod.MODEL_PATH)
    snapshot_download(tts_mod.MODEL_REPO, local_dir=str(model_path))

def download_pocket():
    from pocket_tts import TTSModel
    TTSModel.load_model()

def download_qwen():
    qwen_path = ROOT / "scripts" / "qwen_tts_daemon.py"
    qwen_mod = load_module(qwen_path, "qwen_tts_daemon")
    variant = os.environ.get("QWEN_TTS_MODEL_VARIANT", "base-0.6b")
    if variant not in qwen_mod.MODEL_VARIANTS:
        raise RuntimeError(f"Unknown Qwen3-TTS model variant: {variant}")
    model_repo = qwen_mod.MODEL_VARIANTS[variant]["repo"]
    import torch
    with qwen_mod.suppress_flash_attn_warning():
        from qwen_tts import Qwen3TTSModel
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    Qwen3TTSModel.from_pretrained(model_repo, device_map=device, dtype=torch.float32)

enable_parakeet = os.environ.get("ENABLE_PARAKEET") == "1"
enable_kokoro = os.environ.get("ENABLE_KOKORO") == "1"
enable_pocket = os.environ.get("ENABLE_POCKET") == "1"
enable_qwen = os.environ.get("ENABLE_QWEN") == "1"

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

if enable_qwen:
    run_step("Qwen3-TTS", download_qwen)
else:
    print("\n==> Qwen3-TTS: skipped (disabled)")
PY

        deactivate
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
    export ENABLE_QWEN

    if [ "$ENABLE_QWEN" = "1" ]; then
        export QWEN_TTS_MODEL_VARIANT="$QWEN_VARIANT"
    fi

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
    from parakeet_mlx import from_pretrained
    from_pretrained("mlx-community/parakeet-tdt-0.6b-v3")

def download_kokoro():
    tts_path = ROOT / "scripts" / "tts_daemon.py"
    tts_mod = load_module(tts_path, "tts_daemon")
    from huggingface_hub import snapshot_download
    model_path = Path(tts_mod.MODEL_PATH)
    snapshot_download(tts_mod.MODEL_REPO, local_dir=str(model_path))

def download_pocket():
    from pocket_tts import TTSModel
    TTSModel.load_model()

def download_qwen():
    qwen_path = ROOT / "scripts" / "qwen_tts_daemon.py"
    qwen_mod = load_module(qwen_path, "qwen_tts_daemon")
    variant = os.environ.get("QWEN_TTS_MODEL_VARIANT", "base-0.6b")
    if variant not in qwen_mod.MODEL_VARIANTS:
        raise RuntimeError(f"Unknown Qwen3-TTS model variant: {variant}")
    model_repo = qwen_mod.MODEL_VARIANTS[variant]["repo"]
    import torch
    with qwen_mod.suppress_flash_attn_warning():
        from qwen_tts import Qwen3TTSModel
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    Qwen3TTSModel.from_pretrained(model_repo, device_map=device, dtype=torch.float32)

enable_parakeet = os.environ.get("ENABLE_PARAKEET") == "1"
enable_kokoro = os.environ.get("ENABLE_KOKORO") == "1"
enable_pocket = os.environ.get("ENABLE_POCKET") == "1"
enable_qwen = os.environ.get("ENABLE_QWEN") == "1"

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

if enable_qwen:
    run_step("Qwen3-TTS", download_qwen)
else:
    print("\n==> Qwen3-TTS: skipped (disabled)")
PY

    deactivate

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
        printf '%b\n' "  ${CHECK} Qwen3-TTS ($QWEN_VARIANT)"
    else
        printf '%b\n' "  ${CROSS} Qwen3-TTS (disabled)"
    fi
    echo ""

    # Transcription
    echo "Transcription:"
    if [ "$ENABLE_PARAKEET" = "1" ]; then
        printf '%b\n' "  ${CHECK} Parakeet (STT) enabled"
    else
        printf '%b\n' "  ${CROSS} Parakeet (STT) disabled"
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
    if [ "$ENABLE_POCKET" = "1" ]; then
        echo "  Pocket TTS          ~200 MB     30-60 seconds"
    fi
    if [ "$ENABLE_KOKORO" = "1" ]; then
        echo "  Kokoro TTS          ~300 MB     30-60 seconds"
    fi
    if [ "$ENABLE_QWEN" = "1" ]; then
        if [ "$QWEN_VARIANT" = "base-1.7b" ]; then
            echo "  Qwen3-TTS (1.7B)    ~3.5 GB     5-10 minutes"
        else
            echo "  Qwen3-TTS           ~1.2 GB     2-4 minutes"
        fi
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
    predownload_models
    print_summary
}

# Run main function
main
