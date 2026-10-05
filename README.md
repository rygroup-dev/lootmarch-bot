# LootMarch Bot ⚔️

Panel kontrol Telegram untuk **satu akun** [LootMarch](https://lootmarch.xyz), game idle dungeon crawler di Robinhood Chain. Semua yang biasanya diklik di web bisa diatur dari Telegram, ditambah autopilot yang mengurus klaim harian dan memperkuat hero sambil kamu offline.

## Pasang (satu baris)

```bash
curl -fsSL https://raw.githubusercontent.com/rygroup-dev/lootmarch-bot/main/install.sh | bash
```

Installer akan:
1. memasang `git`, `curl`, dan Node.js 22 kalau belum ada,
2. clone repo ke `~/lootmarch-bot` dan memasang dependency,
3. menanyakan **BOT_TOKEN** (dari [@BotFather](https://t.me/BotFather)) dan **ID Telegram** kamu (cek di [@userinfobot](https://t.me/userinfobot)),
4. membuat `SECRET_KEY` acak dan menjalankan bot sebagai service systemd `lootmarch-bot`.

Lalu buka bot kamu di Telegram: `/start` → 💰 Wallet → 🔑 Import key. Bot langsung login ke game.

Update ke versi terbaru: jalankan perintah yang sama lagi (`.env` dan data kamu tetap aman).

## Fitur

| Menu | Isi |
|---|---|
| 🏠 Home | Level, floor/region, saldo $LM (+nilai $), Bone, loot menunggu, status live check, pemain online |
| 🧝 Hero | Attribute (+STR/VIT/AGI/DEF/VAM), auto-alokasi per build, gear terpasang, Equip best |
| 🎒 Inventory | Semua item dengan rarity & stat (termasuk level forge), pakai/lepas, forge +1/+5, jual, buang, salvage |
| 🎁 Loot & AFK | Klaim loot chest, cek & klaim hadiah AFK |
| 📜 Quest | Misi harian, daily reward, login streak, klaim semua |
| 🎫 Pass | Tier & XP March Pass, klaim, **analisa untung/rugi premium**, beli pakai $LM atau ETH |
| 🗺 Travel | Pindah region/floor (cooldown 30 menit), buka seal floor |
| 🐾 Pet | Koleksi pet, level & bonus, pakai/lepas, feed Bone, buka pet chest |
| 🛒 Shop | Chest gear & mythic, pet chest, bone pack, bayar $LM atau ETH |
| 🏪 Market | Telusuri dengan filter rarity/slot, beli, jual, batalkan listing, riwayat |
| 💰 Wallet | Saldo ETH & $LM on-chain, deposit ke game, withdraw, kirim ETH/$LM, klaim deposit pakai tx hash |
| 📖 Codex | Progres koleksi item per rarity, koleksi pet, musuh yang ditemui |
| 🏆 Ranks | Papan Terdalam & Level |

### Autopilot (tiap 5 menit, bisa diatur di ⚙️ Setelan)

- 💤 klaim AFK setiap N jam (default 4, maks dari server 8 jam)
- 🎁 klaim loot → 🧥 Equip best → ♻️ salvage gear cadangan (1 copy selalu disisakan)
- 📈 alokasi attribute point otomatis sesuai build (Seimbang / Damage / Tank)
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
- Kalau server minta captcha saat login, login sekali di browser lalu kirim header Cookie lewat ⚙️ → 🍪 Pakai cookie.
- **Pakai wallet khusus game**, jangan wallet utama.

## Penting

- Docs LootMarch melarang botting dan multi-akun, dan pelanggarannya bisa berujung ban. Bot ini dibuat untuk **1 orang = 1 akun**, dan risiko pemakaian ditanggung masing-masing.
- Proyek independen, tidak berafiliasi dengan LootMarch.

## Pengembangan

```bash
npm install
cp .env.example .env   # isi BOT_TOKEN, OWNER_IDS, SECRET_KEY
npm test               # 29 tes, tanpa jaringan
npm start
```

Struktur: `src/api.js` (klien HTTP game) · `src/auth.js` (login SIWE) · `src/wallet.js` (ethers, Robinhood Chain) · `src/game.js` (aksi game) · `src/autopilot.js` · `src/views.js` (tampilan Telegram) · `src/bot.js` (router) · `data/catalog.json` (katalog item/pet/region).
