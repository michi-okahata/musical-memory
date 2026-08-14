#!/usr/bin/env bash
#
# Flow — one-step installer.
#
# For debaters: you do not need to understand any of this. Open a Terminal,
# type the following, and press Enter:
#
#     cd ~/Downloads/flow && bash install.sh
#
# (Replace ~/Downloads/flow with wherever this folder actually is. Easiest way:
#  type "cd " with a space, then drag the folder onto the Terminal window.)
#
# It will install what's missing, build the app, and tell you where it landed.
# First run takes 10-25 minutes, mostly waiting. Later runs take about a minute.

set -euo pipefail

NVM_VERSION="v0.40.3"   # bump if nvm's installer moves on
NODE_MAJOR_MIN=20       # Vite 7 needs 20.19+; we install the LTS when missing

cd "$(dirname "${BASH_SOURCE[0]}")"
LOG="$PWD/install-log.txt"
: > "$LOG"

# ---------------------------------------------------------------- pretty output

if [ -t 1 ]; then BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; OFF=$'\033[0m'
else BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; OFF=""; fi

step()  { printf "\n%s==>%s %s%s%s\n" "$GREEN" "$OFF" "$BOLD" "$1" "$OFF"; }
info()  { printf "    %s\n" "$1"; }
muted() { printf "%s    %s%s\n" "$DIM" "$1" "$OFF"; }
warn()  { printf "%s !  %s%s\n" "$YELLOW" "$1" "$OFF"; }

# Anything noisy goes to the log; we only surface it if something breaks.
run() { muted "$1"; shift; "$@" >>"$LOG" 2>&1; }

fail() {
  printf "\n%s%sSomething went wrong.%s\n" "$RED" "$BOLD" "$OFF"
  printf "  The last 20 lines of the log:\n\n"
  tail -n 20 "$LOG" | sed 's/^/    /'
  printf "\n  Full log: %s\n" "$LOG"
  printf "  Send that file to whoever gave you this app and they can sort it out.\n\n"
  exit 1
}
trap fail ERR

# ------------------------------------------------------------------- what am I?

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux)  OS=linux ;;
  MINGW*|MSYS*|CYGWIN*)
    printf "\n%sThis script is for macOS and Linux.%s\n\n" "$BOLD" "$OFF"
    printf "  On Windows, install these three things (click through the defaults),\n"
    printf "  then run:  npm install  and  npm run tauri build\n\n"
    printf "    1. Microsoft C++ Build Tools  https://visualstudio.microsoft.com/visual-cpp-build-tools/\n"
    printf "       (check the \"Desktop development with C++\" box)\n"
    printf "    2. Rust                       https://www.rust-lang.org/tools/install\n"
    printf "    3. Node.js LTS                https://nodejs.org\n\n"
    exit 1 ;;
  *) printf "Unrecognised system: %s\n" "$(uname -s)"; exit 1 ;;
esac

printf "\n%s  Flow — installer%s\n" "$BOLD" "$OFF"
muted "  Detailed output goes to install-log.txt"

# --------------------------------------------------- 1. compiler / system stuff

if [ "$OS" = mac ]; then
  step "Checking Apple's developer tools"
  if xcode-select -p >/dev/null 2>&1; then
    info "Already installed."
  else
    info "Missing — asking macOS to install them."
    warn "A window will pop up. Click Install, agree, and leave it running."
    xcode-select --install >/dev/null 2>&1 || true
    info "Waiting for that to finish (this can take 10+ minutes)..."
    until xcode-select -p >/dev/null 2>&1; do sleep 20; done
    info "Done."
  fi
else
  step "Checking Linux system libraries"
  # Tauri draws its window with WebKitGTK; these are the packages it needs.
  if command -v apt-get >/dev/null 2>&1; then
    warn "This step needs your password (it installs system packages)."
    sudo apt-get update >>"$LOG" 2>&1
    sudo apt-get install -y \
      build-essential curl wget file pkg-config \
      libwebkit2gtk-4.1-dev librsvg2-dev libssl-dev \
      libayatana-appindicator3-dev libxdo-dev >>"$LOG" 2>&1
  elif command -v dnf >/dev/null 2>&1; then
    warn "This step needs your password (it installs system packages)."
    sudo dnf install -y \
      @development-tools curl wget file \
      webkit2gtk4.1-devel librsvg2-devel openssl-devel \
      libappindicator-gtk3-devel libxdo-devel >>"$LOG" 2>&1
  elif command -v pacman >/dev/null 2>&1; then
    warn "This step needs your password (it installs system packages)."
    sudo pacman -Syu --needed --noconfirm \
      base-devel curl wget file openssl \
      webkit2gtk-4.1 librsvg libappindicator-gtk3 xdotool >>"$LOG" 2>&1
  else
    warn "Unknown Linux package manager — skipping."
    warn "If the build fails, install the WebKitGTK 4.1 dev packages by hand."
  fi
  info "Done."
fi

# ------------------------------------------------------------------- 2. node.js

step "Checking Node.js"

# nvm-installed Node lives in a shell function, not on PATH, so load it first.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR_MIN" ]
}

if node_ok; then
  info "Found Node $(node --version)."
else
  info "Need Node $NODE_MAJOR_MIN or newer — installing it just for you (no password needed)."
  muted "Downloading nvm $NVM_VERSION from github.com/nvm-sh/nvm"
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash >>"$LOG" 2>&1
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  run "Installing the current Node LTS" nvm install --lts
  nvm use --lts >>"$LOG" 2>&1
  node_ok || { echo "Node still too old after install" >>"$LOG"; false; }
  info "Installed Node $(node --version)."
fi

# ---------------------------------------------------------------------- 3. rust

step "Checking Rust"

# shellcheck disable=SC1091
[ -s "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

if command -v cargo >/dev/null 2>&1; then
  info "Found $(cargo --version)."
else
  info "Missing — installing it just for you (no password needed)."
  muted "Downloading rustup from rustup.rs (the official Rust installer)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y >>"$LOG" 2>&1
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
  info "Installed $(cargo --version)."
fi

# ------------------------------------------------------- 4. project + build

step "Installing the app's own dependencies"
if [ -f package-lock.json ]; then
  run "npm ci" npm ci
else
  run "npm install" npm install
fi
info "Done."

step "Building Flow"
info "This is the long part — 10-20 minutes the first time, about a minute after."
info "It looks like it's frozen sometimes. It isn't. Go get coffee."
npm run tauri build >>"$LOG" 2>&1
info "Built."

# ------------------------------------------------------------- 5. hand it over

BUNDLE="src-tauri/target/release/bundle"

printf "\n%s%s  Flow is built.%s\n" "$GREEN" "$BOLD" "$OFF"

if [ "$OS" = mac ]; then
  APP="$(find "$BUNDLE/macos" -maxdepth 1 -name '*.app' 2>/dev/null | head -n 1)"
  DMG="$(find "$BUNDLE/dmg"   -maxdepth 1 -name '*.dmg' 2>/dev/null | head -n 1)"
  [ -n "$APP" ] && printf "\n  The app:  %s\n" "$PWD/$APP"
  [ -n "$DMG" ] && printf "  Installer to share with others:  %s\n" "$PWD/$DMG"

  if [ -n "$APP" ]; then
    printf "\n  Copy it into your Applications folder now? [y/N] "
    read -r reply || reply=n
    case "$reply" in
      [Yy]*)
        rm -rf "/Applications/$(basename "$APP")"
        cp -R "$APP" /Applications/
        printf "  Installed. It's in Launchpad and Spotlight as Flow.\n" ;;
      *)
        printf "  Left it where it is — double-click it to run.\n" ;;
    esac
    printf "\n  %sFirst launch:%s macOS may say it can't verify the developer.\n" "$DIM" "$OFF"
    printf "  %sRight-click the app, choose Open, then click Open again. Once only.%s\n" "$DIM" "$OFF"
  fi
else
  printf "\n  Ready-to-install files are in:  %s\n" "$PWD/$BUNDLE"
  find "$BUNDLE" -maxdepth 2 \( -name '*.deb' -o -name '*.AppImage' -o -name '*.rpm' \) \
    2>/dev/null | sed 's|^|    |'
  printf "\n  Double-click the .deb (Debian/Ubuntu) or .rpm (Fedora) to install,\n"
  printf "  or make the .AppImage executable and run it directly.\n"
fi

printf "\n"
