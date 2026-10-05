# LootMarch Bot ⚔️

Panel kontrol Telegram untuk **satu akun** [LootMarch](https://lootmarch.xyz), game idle dungeon crawler di Robinhood Chain. Semua yang biasanya diklik di web bisa diatur dari Telegram, ditambah autopilot yang mengurus klaim harian dan memperkuat hero sambil kamu offline.

## Pasang (satu baris)

| Perangkat | Perintah | Jalan 24 jam? |
|---|---|---|
| 📱 HP Android (Termux) | `curl -fsSL https://raw.githubusercontent.com/rygroup-dev/lootmarch-bot/main/install.sh \| bash` | Ya, selama HP menyala |
| 🖥 VPS / Linux | perintah yang sama | Ya (+ opsi layar game 24 jam) |
| 🪟 Windows 10/11 | `irm https://raw.githubusercontent.com/rygroup-dev/lootmarch-bot/main/install.ps1 \| iex` | Selama PC menyala |

### 📱 HP Android (Termux)

1. Pasang **Termux** dari [F-Droid](https://f-droid.org/packages/com.termux/) (versi Play Store sudah usang).
2. Buka Termux, tempel perintah di atas. Installer mendeteksi Termux otomatis, memasang `git` + `nodejs-lts`, lalu menjalankan bot di latar belakang dengan *wake lock*.
3. Settings → Apps → Termux → Battery → **Unrestricted**, supaya Android tidak mematikan bot.
4. (Opsional) Pasang **Termux:Boot** dari F-Droid dan buka sekali → bot ikut menyala setelah HP restart.

Kelola: `~/lootmarch-bot/scripts/termux.sh status|log|stop|restart`.

Main online dari HP: tombol **🎮 Main di browser** atau **🦊 Buka di MetaMask** di dashboard Telegram membuka game di Kiwi/Brave (dengan ekstensi wallet) atau di browser bawaan MetaMask.

### 🖥 VPS / Linux

Installer memasang `git`, `curl`, dan Node.js 22 kalau belum ada, clone ke `~/lootmarch-bot`, menanyakan **BOT_TOKEN** dan **ID Telegram**, membuat `SECRET_KEY` acak, lalu menjalankan bot sebagai service systemd `lootmarch-bot`.

**Layar game 24 jam (opsional, ditanya saat install):** memasang Chromium di layar virtual VPS + noVNC lewat HTTPS dengan password, jadi game bisa jalan terus tanpa PC. Buka linknya sekali dari browser mana pun, pasang Rabby/MetaMask di Chromium itu, login ke `lootmarch.xyz/play`, lalu tinggal. Saat game minta centang "Verify you are human", bot mengirim alert + link layar; kamu yang mencentang. Butuh ±1 core & 1,5 GB RAM. Mau pasang belakangan: `LM_DESKTOP=1` lalu jalankan installer lagi. Punya sertifikat domain sendiri: set `LM_CERT` & `LM_KEY` (default self-signed).

### 🪟 Windows 10/11

Buka **PowerShell** (tidak perlu Administrator), lalu tempel:

```powershell
irm https://raw.githubusercontent.com/rygroup-dev/lootmarch-bot/main/install.ps1 | iex
```

Installer memasang Node.js LTS (lewat `winget` atau MSI resmi), mengunduh kode ke `%USERPROFILE%\lootmarch-bot` (tanpa perlu git), menanyakan token & ID Telegram, lalu menjalankan bot **di latar belakang** dan otomatis start setiap login Windows (Task Scheduler `LootMarchBot`). Kalau crash, bot restart sendiri dalam 10 detik.

| Perlu | Perintah |
|---|---|
| Lihat log | `notepad %USERPROFILE%\lootmarch-bot\bot.log` |
| Hentikan | `powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\lootmarch-bot\windows\stop.ps1"` |
| Jalankan lagi | `Start-ScheduledTask -TaskName LootMarchBot` |
| Update | jalankan perintah install yang sama (`.env` & data aman) |

Di Windows, bot hanya jalan selama PC menyala. Matikan *Sleep* di Settings → System → Power kalau mau jalan terus.

### Setelah terpasang

Buka bot kamu di Telegram: `/start` → 💰 Wallet → 🔑 Import key. Bot langsung login ke game dengan private key. Akun baru akan diajak memilih class, nama, dan tampilan hero.

Bahan yang dibutuhkan: token bot dari [@BotFather](https://t.me/BotFather) dan ID Telegram dari [@userinfobot](https://t.me/userinfobot).

## Fitur

| Menu | Isi |
|---|---|
| 🏠 Dashboard | Level, Power, gear, floor/region, saldo $LM (+nilai $), Bone, chest, progres quest & pass, live check, kapan autopilot terakhir jalan, AFK berikutnya, cooldown travel |
| 🆕 Buat hero | Akun baru: pilih class (dengan penjelasan skill), nama, tampilan (preset class / acak) |
| 🧝 Hero | Stat lengkap, attribute (+STR/VIT/AGI/DEF/VAM), build otomatis per class, Equip best, 🛍 Upgrade dari Market |
| 🎒 Inventory | Semua item dengan rarity & stat (termasuk level forge), pakai/lepas, forge +1/+5, jual, buang, salvage |
| 🎁 Loot & AFK | Klaim loot chest, cek & klaim hadiah AFK |
| 📜 Quest | Misi harian, daily reward, login streak, klaim semua |
| 🐦 Share di X | Quest "Share your run" (+5.000 $LM/hari): hubungkan X sekali, pilih 1 dari 3 teks resmi game → X terbuka terisi → Post → kirim link ke bot. Bot cek username & melaporkan status review |
| 🎫 Pass | Tier & XP March Pass, klaim, **analisa untung/rugi premium**, beli pakai $LM atau ETH |
| 🗺 Travel | Pindah region/floor (cooldown 30 menit), buka seal floor |
| 🐾 Pet | Koleksi pet, level & bonus, pakai/lepas, feed Bone, buka pet chest |
| 🛒 Shop | Chest gear & mythic, pet chest, bone pack, bayar $LM atau ETH |
| 🏪 Market | Telusuri dengan filter rarity/slot, beli, jual, batalkan listing, riwayat |
| 💰 Wallet | Saldo ETH & $LM on-chain, deposit ke game, withdraw, kirim ETH/$LM, klaim deposit pakai tx hash |
| 📖 Codex | Progres koleksi item per rarity, koleksi pet, musuh yang ditemui |
| 🏆 Ranks | Papan Terdalam & Level |
| 📋 Log | Riwayat aksi autopilot & aksi manual penting, dengan jam (WIB) |

### Autopilot (tiap 5 menit, bisa diatur di ⚙️ Setelan)

- 💤 klaim AFK setiap N jam (default 4, maks dari server 8 jam)
- 🎁 klaim loot → 📦 buka chest & pet chest yang dimiliki (hadiah pass/quest) → 🧥 Equip best → ♻️ salvage gear cadangan (1 copy selalu disisakan)
- 🛍 upgrade gear dari market: beli listing dengan kenaikan Power terbesar per $LM, maks 50% saldo per putaran, senjata sesuai class
- 📈 alokasi attribute point otomatis. Build *Otomatis* memilih per class: Wand/Spear → Damage, Sword/Axe/Dagger → Seimbang (VAM & AGI maks 20)
- 🔓 **deteksi floor**: begitu 11 region clear, seal floor berikutnya dibuka kalau $LM & Bone cukup (hadiah ×1,5 per floor)
- 🔨 auto forge (opsional, mati secara default) dengan batas cadangan $LM & Bone
- 📜 klaim misi, daily reward, login streak · 🎫 klaim tier pass
- 🛡 peringatan kalau $LM tertahan live check · 🎉 notifikasi drop Legendary/Mythic kamu

Setiap aksi yang menghabiskan $LM/ETH (beli, forge manual, withdraw, kirim) selalu minta konfirmasi tombol ✅.

## Online vs AFK

Hadiah AFK = **75% dari rate online kamu sendiri** (24 jam terakhir), maksimal 8 jam per klaim. Pertarungan room tetap berjalan di game asli: buka `lootmarch.xyz/play` di browser, hero jalan sendiri. Server menahan $LM dari room sampai **live check** (captcha Cloudflare) lolos. Bot tidak menyelesaikan captcha; bot hanya memberi tahu kapan kamu perlu membuka game sebentar.

## Login & keamanan

- Login memakai **private key** (tanda tangan pesan SIWE, gratis, tidak mengirim transaksi). Pesan yang ditandatangani dicek dulu: harus dari `lootmarch.xyz`, chain 4663, dan alamat kamu.
- Private key & cookie disimpan terenkripsi **AES-256-GCM** di `data/state.json` (permission 600) memakai `SECRET_KEY` dari `.env`. Pesan Telegram berisi key langsung dihapus.
- Hanya ID Telegram di `OWNER_IDS` yang bisa memakai bot.
- Sesi login diurus otomatis: kalau habis, bot login ulang sendiri pakai key. (Cadangan darurat: kalau suatu saat server minta captcha, login di browser lalu kirim header Cookie lewat `/cookie`.)
- **Pakai wallet khusus game**, jangan wallet utama.

## Penting

- Docs LootMarch melarang botting dan multi-akun, dan pelanggarannya bisa berujung ban. Bot ini dibuat untuk **1 orang = 1 akun**, dan risiko pemakaian ditanggung masing-masing.
- Proyek independen, tidak berafiliasi dengan LootMarch.

## Pengembangan

```bash
npm install
cp .env.example .env   # isi BOT_TOKEN, OWNER_IDS, SECRET_KEY
npm test               # 45 tes, tanpa jaringan
npm start
```

Struktur: `src/api.js` (klien HTTP game) · `src/auth.js` (login SIWE) · `src/wallet.js` (ethers, Robinhood Chain) · `src/game.js` (aksi game) · `src/autopilot.js` · `src/views.js` (tampilan Telegram) · `src/bot.js` (router) · `data/catalog.json` (katalog item/pet/region).
