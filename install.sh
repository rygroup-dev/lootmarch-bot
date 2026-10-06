#!/usr/bin/env bash
# LootMarch Bot installer — Linux/VPS and Android (Termux)
#   curl -fsSL https://raw.githubusercontent.com/rygroup-dev/lootmarch-bot/main/install.sh | bash
# Windows: see install.ps1
set -euo pipefail

REPO="${LM_REPO:-https://github.com/rygroup-dev/lootmarch-bot.git}"
DIR="${LM_DIR:-$HOME/lootmarch-bot}"
SERVICE="${LM_SERVICE:-lootmarch-bot}"
DESKTOP_PORT="${LM_DESKTOP_PORT:-6090}"
DEFAULT_REF="${LM_REFERRAL:-V49L3K}"   # bot author's LootMarch referral code, shown and changeable at install

c() { printf '\033[1;36m%s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
ask() { local v; read -r -p "$1" v </dev/tty; printf '%s' "$v"; }

TERMUX=0
if [ -n "${TERMUX_VERSION:-}" ] || [[ "${PREFIX:-}" == *com.termux* ]]; then TERMUX=1; fi

SUDO=""; CAN_ROOT=0
if [ "$TERMUX" = 0 ]; then
  if [ "$(id -u)" -eq 0 ]; then CAN_ROOT=1
  elif command -v sudo >/dev/null; then SUDO="sudo"; CAN_ROOT=1; fi
fi

c "== LootMarch Bot installer ($([ "$TERMUX" = 1 ] && echo 'Android/Termux' || echo 'Linux')) =="

# 1) git, curl, Node.js >= 20
node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
if [ "$TERMUX" = 1 ]; then
  c "Memasang paket Termux (git, nodejs-lts)…"
  pkg update -y >/dev/null 2>&1 || true
  pkg install -y git nodejs-lts
else
  if ! command -v git >/dev/null || ! command -v curl >/dev/null; then
    c "Memasang git & curl…"
    if command -v apt-get >/dev/null; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git curl ca-certificates
    elif command -v dnf >/dev/null; then $SUDO dnf install -y git curl
    elif command -v yum >/dev/null; then $SUDO yum install -y git curl
    else die "Pasang git dan curl dulu."; fi
  fi
  if ! node_ok; then
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
fi
node_ok || die "Node.js 20+ belum terpasang."
ok "Node $(node -v)"

# 2) code
if [ -d "$DIR/.git" ]; then
  c "Update kode di $DIR…"; git -C "$DIR" pull --ff-only
else
  c "Clone ke $DIR…"; git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
ok "Dependency terpasang"

# 3) .env
if [ ! -f .env ]; then
  c "Setelan bot (buat bot di @BotFather, cek ID Telegram di @userinfobot)"
  token=$(ask "BOT_TOKEN: ")
  [ -n "$token" ] || die "BOT_TOKEN wajib."
  owner=$(ask "ID Telegram kamu (OWNER_IDS): ")
  [[ "$owner" =~ ^[0-9,\ ]+$ ]] || die "OWNER_IDS harus angka."
  ref=$(ask "Kode referral untuk akun baru [${DEFAULT_REF}] (Enter = pakai, '-' = tanpa referral): ")
  [ -z "$ref" ] && ref="$DEFAULT_REF"
  [ "$ref" = "-" ] && ref=""
  secret=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
  umask 077
  printf 'BOT_TOKEN=%s\nOWNER_IDS=%s\nSECRET_KEY=%s\nREFERRAL_CODE=%s\n' "$token" "$owner" "$secret" "$ref" > .env
  ok ".env dibuat (SECRET_KEY acak; JANGAN hilang, dipakai untuk membuka private key tersimpan)"
else
  ok ".env sudah ada, dipakai ulang"
fi
chmod 600 .env
mkdir -p data && chmod 700 data

set_env() { # set_env KEY VALUE  (replace or append in .env; values may contain & ? /)
  { grep -v "^$1=" .env || true; printf '%s=%s\n' "$1" "$2"; } > .env.tmp && mv .env.tmp .env && chmod 600 .env
}

# 4a) Android / Termux: background loop + optional autostart via Termux:Boot
if [ "$TERMUX" = 1 ]; then
  chmod +x scripts/termux.sh
  scripts/termux.sh restart >/dev/null
  mkdir -p "$HOME/.termux/boot"
  printf '#!/data/data/com.termux/files/usr/bin/sh\n%s/scripts/termux.sh start\n' "$DIR" > "$HOME/.termux/boot/lootmarch-bot"
  chmod +x "$HOME/.termux/boot/lootmarch-bot"
  ok "Bot jalan di latar belakang (layar HP boleh mati)."
  echo "  Status : $DIR/scripts/termux.sh status"
  echo "  Log    : $DIR/scripts/termux.sh log"
  echo "  Stop   : $DIR/scripts/termux.sh stop"
  echo "  Penting: Settings → Apps → Termux → Battery → Unrestricted, supaya Android tidak mematikan bot."
  echo "  Auto-start setelah HP restart: pasang aplikasi Termux:Boot (F-Droid) dan buka sekali."
  c "Selesai! Buka bot kamu di Telegram lalu kirim /start → 💰 Wallet → 🔑 Import key."
  c "Main online: tombol 🎮 / 🦊 di dashboard membuka game di Kiwi/Brave/MetaMask."
  exit 0
fi

# 4b) Linux: systemd service
NODE_BIN=$(command -v node)
HAS_SYSTEMD=0
if command -v systemctl >/dev/null && [ -d /run/systemd/system ] && [ "$CAN_ROOT" = 1 ]; then HAS_SYSTEMD=1; fi
if [ "$HAS_SYSTEMD" = 1 ]; then
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
  $SUDO systemctl enable $SERVICE >/dev/null 2>&1
else
  c "systemd tidak tersedia. Jalankan manual:"
  echo "  cd $DIR && nohup node src/index.js > bot.log 2>&1 &"
fi

# 5) optional: 24/7 game screen on this VPS (Chromium + noVNC over HTTPS)
#    You open it from any browser, log in with your wallet once and click the
#    human check when the bot asks. Nothing here plays or clicks for you.
setup_desktop() {
  command -v apt-get >/dev/null || { echo "  (butuh Debian/Ubuntu, dilewati)"; return; }
  c "Memasang Chromium + layar virtual + noVNC…"
  $SUDO apt-get install -y -qq xvfb openbox x11vnc novnc websockify openssl fonts-noto-color-emoji >/dev/null
  $SUDO apt-get install -y -qq chromium >/dev/null 2>&1 || $SUDO apt-get install -y -qq chromium-browser >/dev/null
  local CHROME; CHROME=$(command -v chromium || command -v chromium-browser) || { echo "  Chromium tidak terpasang, dilewati"; return; }
  local D="$DIR/desktop"; mkdir -p "$D/profile"; chmod 700 "$D"
  local IP; IP=$(curl -s -4 -m 5 ifconfig.me || hostname -I | awk '{print $1}')
  local VNCPASS TOKEN SECRET
  VNCPASS=$(openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | head -c 8)
  TOKEN=$(openssl rand -hex 16)      # gates the screen connection
  SECRET=$(openssl rand -hex 12)     # hides the noVNC page behind a random path
  x11vnc -storepasswd "$VNCPASS" "$D/vncpass" >/dev/null 2>&1
  printf '%s: localhost:5977\n' "$TOKEN" > "$D/tokens"
  mkdir -p "$D/web"; printf '<!doctype html><title>Not found</title><h1>404</h1>\n' > "$D/web/index.html"
  ln -sfn /usr/share/novnc "$D/web/$SECRET"
  if [ -n "${LM_CERT:-}" ] && [ -n "${LM_KEY:-}" ]; then cp "$LM_CERT" "$D/cert.pem"; cp "$LM_KEY" "$D/key.pem"
  else openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$IP" -addext "subjectAltName=IP:$IP" -keyout "$D/key.pem" -out "$D/cert.pem" >/dev/null 2>&1; fi
  chmod 600 "$D"/*.pem "$D/vncpass" "$D/tokens"
  local U=/etc/systemd/system
  $SUDO tee $U/lm-xvfb.service >/dev/null <<EOF
[Unit]
Description=LootMarch desktop: virtual display :77
[Service]
ExecStart=$(command -v Xvfb) :77 -screen 0 1280x800x24 -nolisten tcp
Restart=always
[Install]
WantedBy=multi-user.target
EOF
  $SUDO tee $U/lm-openbox.service >/dev/null <<EOF
[Unit]
Description=LootMarch desktop: window manager
After=lm-xvfb.service
Requires=lm-xvfb.service
[Service]
Environment=DISPLAY=:77
ExecStartPre=/bin/sleep 2
ExecStart=$(command -v openbox)
Restart=always
[Install]
WantedBy=multi-user.target
EOF
  # throttling flags keep the tab running like a visible window on a PC
  $SUDO tee $U/lm-chromium.service >/dev/null <<EOF
[Unit]
Description=LootMarch desktop: Chromium with the game
After=lm-openbox.service
Requires=lm-xvfb.service
[Service]
Environment=DISPLAY=:77
ExecStartPre=/bin/sleep 3
ExecStart=$CHROME --no-sandbox --user-data-dir=$D/profile --no-first-run --no-default-browser-check --start-maximized --window-size=1280,800 --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-dev-shm-usage --password-store=basic https://lootmarch.xyz/play
Restart=always
RestartSec=10
CPUQuota=150%
MemoryMax=2G
[Install]
WantedBy=multi-user.target
EOF
  $SUDO tee $U/lm-vnc.service >/dev/null <<EOF
[Unit]
Description=LootMarch desktop: VNC server (localhost only)
After=lm-xvfb.service
Requires=lm-xvfb.service
[Service]
ExecStartPre=/bin/sleep 2
ExecStart=$(command -v x11vnc) -display :77 -rfbauth $D/vncpass -localhost -rfbport 5977 -forever -shared -noxdamage -quiet
Restart=always
[Install]
WantedBy=multi-user.target
EOF
  $SUDO tee $U/lm-novnc.service >/dev/null <<EOF
[Unit]
Description=LootMarch desktop: noVNC over HTTPS, screen gated by a secret token
After=lm-vnc.service
[Service]
ExecStart=$(command -v websockify) --web $D/web --cert $D/cert.pem --key $D/key.pem --ssl-only --token-plugin TokenFile --token-source $D/tokens $DESKTOP_PORT
Restart=always
[Install]
WantedBy=multi-user.target
EOF
  $SUDO chmod 600 $U/lm-novnc.service
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now lm-xvfb lm-openbox lm-chromium lm-vnc lm-novnc >/dev/null 2>&1
  if command -v ufw >/dev/null && $SUDO ufw status | grep -q "Status: active"; then $SUDO ufw allow "$DESKTOP_PORT/tcp" >/dev/null; fi
  local URL="https://$IP:$DESKTOP_PORT/$SECRET/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=websockify%3Ftoken%3D$TOKEN&password=$VNCPASS"
  umask 077; printf 'URL=%s\nTOKEN=%s\nVNC_PASS=%s\nWEB_SECRET=%s\n' "$URL" "$TOKEN" "$VNCPASS" "$SECRET" > "$D/credentials"
  set_env DESKTOP_URL "$URL"
  ok "Layar game siap. Link sekali-tap ada di tombol 🖥 dashboard Telegram (juga di $D/credentials)."
  echo "  Link itu = kunci layar kamu, jangan dibagikan. Ganti token: edit $D/tokens dan DESKTOP_URL di .env."
  echo "  Sertifikat self-signed: browser akan memperingatkan sekali, pilih lanjutkan."
  echo "  Buka sekali → pasang Rabby/MetaMask di Chromium → login lootmarch.xyz/play. Setelah itu tab boleh ditinggal."
}
if [ "$HAS_SYSTEMD" = 1 ]; then
  if systemctl is-enabled lm-chromium >/dev/null 2>&1; then
    ok "Layar game 24 jam sudah terpasang sebelumnya"
  else
    want="${LM_DESKTOP:-}"
    [ -n "$want" ] || want=$(ask "Pasang layar game 24 jam di VPS ini (browser + noVNC, ~1 core & 1,5 GB RAM)? [y/N]: ")
    case "$want" in y|Y|yes|1) setup_desktop ;; *) echo "  Dilewati (bisa dipasang nanti: LM_DESKTOP=1 jalankan installer lagi)";; esac
  fi
  $SUDO systemctl restart $SERVICE
  ok "Service '$SERVICE' jalan. Log: journalctl -u $SERVICE -f"
fi

c "Selesai! Buka bot kamu di Telegram lalu kirim /start → 💰 Wallet → 🔑 Import key."
