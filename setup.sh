#!/usr/bin/env bash
# OpenMAIC Local Setup Script
# Checks prerequisites, installs dependencies, and configures environment.

set -euo pipefail

# --- Colors & helpers --------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}[info]${NC}  $*"; }
success() { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC}  $*"; }
error()   { echo -e "${RED}[error]${NC} $*"; }

# --- Banner ------------------------------------------------------------------

echo ""
echo -e "${BOLD}  ___                   __  __    _    ___  ____${NC}"
echo -e "${BOLD} / _ \ _ __   ___ _ __ |  \/  |  / \  |_ _|/ ___|${NC}"
echo -e "${BOLD}| | | | '_ \ / _ \ '_ \| |\/| | / _ \  | || |${NC}"
echo -e "${BOLD}| |_| | |_) |  __/ | | | |  | |/ ___ \ | || |___${NC}"
echo -e "${BOLD} \___/| .__/ \___|_| |_|_|  |_/_/   \_\___|\____|${NC}"
echo -e "${BOLD}      |_|${NC}"
echo -e "  Multi-Agent Interactive Classroom"
echo ""

# --- Check: Node.js ---------------------------------------------------------

REQUIRED_NODE="20.9.0"

if ! command -v node &>/dev/null; then
  error "Node.js is not installed."
  echo "  Install Node.js >= $REQUIRED_NODE from https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/^v//')
if ! printf '%s\n%s\n' "$REQUIRED_NODE" "$NODE_VERSION" | sort -V -C; then
  error "Node.js $NODE_VERSION is too old (need >= $REQUIRED_NODE)."
  echo "  Update Node.js from https://nodejs.org/"
  exit 1
fi

success "Node.js $NODE_VERSION"

# --- Check: pnpm -------------------------------------------------------------

REQUIRED_PNPM="10"

if ! command -v pnpm &>/dev/null; then
  warn "pnpm is not installed."
  echo ""
  read -rp "  Install pnpm now? [Y/n] " answer
  if [[ "${answer:-Y}" =~ ^[Yy]$ ]]; then
    if command -v corepack &>/dev/null; then
      info "Installing pnpm via corepack..."
      corepack enable
      corepack prepare pnpm@latest --activate
    else
      info "Installing pnpm via npm..."
      npm install -g pnpm
    fi
    # Refresh PATH so the newly installed pnpm is found
    NPM_BIN="$(npm config get prefix)/bin"
    export PATH="$NPM_BIN:$PATH"
    hash -r
    success "pnpm installed"
  else
    error "pnpm is required. Install it from https://pnpm.io/installation"
    exit 1
  fi
fi

PNPM_VERSION=$(pnpm -v)
PNPM_MAJOR=$(echo "$PNPM_VERSION" | cut -d. -f1)
if [[ "$PNPM_MAJOR" -lt "$REQUIRED_PNPM" ]]; then
  error "pnpm $PNPM_VERSION is too old (need >= $REQUIRED_PNPM)."
  echo "  Update: corepack prepare pnpm@latest --activate"
  exit 1
fi

success "pnpm $PNPM_VERSION"

# --- Install dependencies ----------------------------------------------------

echo ""
info "Installing dependencies (this may take a minute)..."
pnpm install
success "Dependencies installed"

# --- Configure .env.local ----------------------------------------------------

ENV_FILE=".env.local"
ENV_EXAMPLE=".env.example"

if [[ -f "$ENV_FILE" ]]; then
  echo ""
  success "$ENV_FILE already exists — skipping configuration"
else
  echo ""
  info "Creating $ENV_FILE from $ENV_EXAMPLE..."
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  echo ""
  echo -e "${BOLD}  Configure at least one LLM provider API key.${NC}"
  echo "  Keys are entered silently and stored only in $ENV_FILE."
  echo "  Press Enter to skip a provider."
  echo ""

  HAS_KEY=false

  # Google Gemini (recommended)
  echo -n "  Google API key (recommended — Gemini 3 Flash): "
  read -rs GOOGLE_KEY
  echo ""
  if [[ -n "$GOOGLE_KEY" ]]; then
    sed -i "s/^GOOGLE_API_KEY=.*/GOOGLE_API_KEY=$GOOGLE_KEY/" "$ENV_FILE"
    success "Google API key saved"
    HAS_KEY=true
  fi

  # OpenAI
  echo -n "  OpenAI API key: "
  read -rs OPENAI_KEY
  echo ""
  if [[ -n "$OPENAI_KEY" ]]; then
    sed -i "s/^OPENAI_API_KEY=.*/OPENAI_API_KEY=$OPENAI_KEY/" "$ENV_FILE"
    success "OpenAI API key saved"
    HAS_KEY=true
  fi

  # Anthropic
  echo -n "  Anthropic API key: "
  read -rs ANTHROPIC_KEY
  echo ""
  if [[ -n "$ANTHROPIC_KEY" ]]; then
    sed -i "s/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=$ANTHROPIC_KEY/" "$ENV_FILE"
    success "Anthropic API key saved"
    HAS_KEY=true
  fi

  # Clear key variables from memory
  unset GOOGLE_KEY OPENAI_KEY ANTHROPIC_KEY

  echo ""
  if [[ "$HAS_KEY" == true ]]; then
    success "Environment configured"
  else
    warn "No API keys set. Edit $ENV_FILE to add at least one provider key."
  fi

  echo -e "  You can add more providers later by editing ${BOLD}$ENV_FILE${NC}"
fi

# --- Offer to start dev server -----------------------------------------------

echo ""
echo -e "${GREEN}Setup complete!${NC}"
echo ""
read -rp "  Start the dev server now? [Y/n] " start_answer
if [[ "${start_answer:-Y}" =~ ^[Yy]$ ]]; then
  echo ""
  info "Starting dev server on http://localhost:3000 ..."
  echo ""
  exec pnpm dev
else
  echo ""
  echo "  Run ${BOLD}pnpm dev${NC} when you're ready to start."
  echo ""
fi
