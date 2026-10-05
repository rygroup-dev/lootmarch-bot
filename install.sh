#!/usr/bin/env bash
# LootMarch Bot installer
#   curl -fsSL https://raw.githubusercontent.com/rygroup-dev/lootmarch-bot/main/install.sh | bash
set -euo pipefail

REPO="${LM_REPO:-https://github.com/rygroup-dev/lootmarch-bot.git}"
DIR="${LM_DIR:-$HOME/lootmarch-bot}"
SERVICE="${LM_SERVICE:-lootmarch-bot}"

c() { printf '\033[1;36m%s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
ask() { local v; read -r -p "$1" v </dev/tty; printf '%s' "$v"; }

SUDO=""; CAN_ROOT=0
if [ "$(id -u)" -eq 0 ]; then CAN_ROOT=1
elif command -v sudo >/dev/null; then SUDO="sudo"; CAN_ROOT=1; fi

c "== LootMarch Bot installer =="

# 1) git + curl
if ! command -v git >/dev/null || ! command -v curl >/dev/null; then
  c "Memasang git & curl…"
  if command -v apt-get >/dev/null; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git curl ca-certificates
  elif command -v dnf >/dev/null; then $SUDO dnf install -y git curl
  elif command -v yum >/dev/null; then $SUDO yum install -y git curl
  else die "Pasang git dan curl dulu."; fi
fi

# 2) Node.js >= 20
need_node=1
if command -v node >/dev/null; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 20 ] && need_node=0
fi
if [ "$need_node" = 1 ]; then
  c "Memasang Node.js 22…"
  if command -v apt-get >/dev/null && [ "$CAN_ROOT" = 1 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash - >/dev/null
    $SUDO apt-get install -y -qq nodejs
  else
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"; nvm install 22 >/dev/null; nvm use 22 >/dev/null
  fi
fi
ok "Node $(node -v)"

# 3) code
if [ -d "$DIR/.git" ]; then
  c "Update kode di $DIR…"; git -C "$DIR" pull --ff-only
else
  c "Clone ke $DIR…"; git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
ok "Dependency terpasang"

# 4) .env
if [ ! -f .env ]; then
  c "Setelan bot (buat bot di @BotFather, cek ID Telegram di @userinfobot)"
  token=$(ask "BOT_TOKEN: ")
  [ -n "$token" ] || die "BOT_TOKEN wajib."
  owner=$(ask "ID Telegram kamu (OWNER_IDS): ")
  [[ "$owner" =~ ^[0-9,\ ]+$ ]] || die "OWNER_IDS harus angka."
  secret=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
  umask 077
  cat > .env <<EOF
BOT_TOKEN=$token
OWNER_IDS=$owner
SECRET_KEY=$secret
EOF
  ok ".env dibuat (SECRET_KEY acak; JANGAN hilang, dipakai untuk membuka private key tersimpan)"
else
  ok ".env sudah ada, dipakai ulang"
fi
chmod 600 .env
mkdir -p data && chmod 700 data

# 5) service
NODE_BIN=$(command -v node)
if command -v systemctl >/dev/null && [ -d /run/systemd/system ] && [ "$CAN_ROOT" = 1 ]; then
  $SUDO tee /etc/systemd/system/$SERVICE.service >/dev/null <<EOF
[Unit]
Description=LootMarch Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$DIR
ExecStart=$NODE_BIN $DIR/src/index.js
Restart=always
RestartSec=10
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now $SERVICE >/dev/null
  $SUDO systemctl restart $SERVICE
  ok "Service '$SERVICE' jalan. Log: journalctl -u $SERVICE -f"
else
  c "systemd tidak tersedia. Jalankan manual:"
  echo "  cd $DIR && nohup node src/index.js > bot.log 2>&1 &"
fi

c "Selesai! Buka bot kamu di Telegram lalu kirim /start → 💰 Wallet → 🔑 Import key."
