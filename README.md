# AutoTrade — Bot SMC/ICT Self-hosted untuk Binance Futures

Sebuah sistem dua proses yang Anda jalankan sendiri: **bot perdagangan TypeScript** yang mengonsumsi data WebSocket K-Line Binance Futures dan menerapkan strategi SMC/ICT, ditambah **dasbor Next.js** yang memungkinkan Anda melihat status/posisi/perdagangan serta mengonfigurasi kredensial API yang terenkripsi. Kedua proses berbasis satu database SQLite (atau MySQL) melalui Prisma, dan keduanya diawasi oleh PM2 agar bertahan saat putus koneksi SSH.

> **Mulai pada TESTNET.** Konfigurasi default (`TESTNET=true`, `LIVE_TRADING=false`) menjalankan strategi dalam mode dry-run terhadap Binance Futures testnet sehingga Anda dapat memvalidasi kualitas sinyal sebelum menanggung risiko apa pun.

---

## 1. Prasyarat

- Node.js **20+** pada VPS (`node -v`)
- npm 10+
- PM2 terpasang secara global: `npm i -g pm2`
- Akun **Binance Futures testnet**: <https://testnet.binancefuture.com/>
  Buat API Key + Secret di sana.

---

## 2. Instalasi

```bash
git clone <url-fork-anda> autotrade && cd autotrade
npm install
cp .env.example .env

# Hasilkan kunci enkripsi master (32 byte acak, base64). Simpan dengan aman —
# kehilangan kunci ini berarti kehilangan akses ke setiap kredensial API yang tersimpan di DB.
npm run keygen
#   → tempel output sebagai ENCRYPTION_KEY=… di .env

# Hasilkan string acak panjang untuk token API dasbor:
npm run keygen
#   → tempel output sebagai DASHBOARD_API_TOKEN=… di .env

# Inisialisasi database SQLite:
npx prisma migrate dev --schema=./prisma/schema.prisma --name init
```

---

## 3. Simpan Kredensial API Binance (terenkripsi)

Jalankan aplikasi web sekali dalam mode development untuk POST konfigurasi Anda:

```bash
npm run web:dev
```

Kemudian di terminal lain:

```bash
curl -X POST http://localhost:3000/api/config \
  -H "Authorization: Bearer $DASHBOARD_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "label": "binance-futures-testnet",
    "testnet": true,
    "apiKey":    "TEMPEL_TESTNET_API_KEY",
    "apiSecret": "TEMPEL_TESTNET_API_SECRET",
    "symbol": "BTCUSDT",
    "interval": "15m",
    "leverage": 5,
    "marginType": "ISOLATED",
    "riskPercent": 1.0,
    "maxConcurrent": 1,
    "enabled": true
  }'
```

Rute ini menggunakan **AES-256-GCM** untuk mengenkripsi kedua rahasia di memori sebelum disimpan. Teks plaintext sama sekali tidak menyentuh database.

---

## 4. Bangun & Jalankan dengan PM2

```bash
npm run build                       # mengkompilasi bot/ dan web/
pm2 start ecosystem.config.js       # bot + web berjalan
pm2 save                            # daftar proses persisted
pm2 startup                         # ikuti perintah yang tercetak untuk mengaktifkan start saat boot
pm2 logs autotrade-bot              # tail log bot
```

PM2 menjaga kedua proses tetap hidup setelah Anda memutus koneksi SSH; jika salah satu crash ia akan di-restart (maksimal 20 kali berturut-tutu sebelum melakukan backoff).

Perintah berguna:
```bash
pm2 status
pm2 reload autotrade-web            # push konfigurasi tanpa downtime
pm2 restart autotrade-bot           # restart bot (mengambil konfigurasi DB baru)
pm2 logs autotrade-bot --lines 200
pm2 monit                           # dasbor CPU/mem live
```

---

## 5. Menuju Live (Mainnet)

Setelah hasil testnet terlihat baik:

1. Hasilkan kunci API baru di Binance mainnet, dibatasi hanya untuk **Perdagangan Futures** dengan whitelist IP.
2. POST ke `/api/config` lagi dengan `testnet: false`, kunci baru, dan `enabled: true`.
3. Di `.env`, atur `LIVE_TRADING=true` dan `TESTNET=false`.
4. `pm2 restart autotrade-bot`.

Selalu beri nilai `riskPercent` rendah saat Anda membangun keyakinan (mulai dari 0,5–1,0).

---

## 6. Ringkasan Arsitektur

```
                         ┌─────────────────────────────────────┐
                         │           Binance Futures           │
                         │   (REST: testnet.binancefuture.com  │
                         │    WS:  stream.binancefuture.com)   │
                         └────────┬────────────────────┬───────┘
                                  │ WS K-Line          │ REST signed
                                  ▼                    ▼
         ┌────────────────────────────────────────────────────────┐
         │                  autotrade-bot (PM2)                   │
         │                                                        │
         │   BinanceStream ── candle ──▶ SMCEngine ── signal ──▶  │
         │       (ws)                  (struktur /     │         │
         │                              OB / FVG)       ▼         │
         │                                       RiskManager      │
         │                                      (pesanan signed)   │
         │                                                        │
         │   ──── persists ───▶ Prisma ───▶ SQLite  ◀──── reads ──┤
         └────────────────────────────────────────────────────────┘
                                                        ▲
                                                        │
         ┌────────────────────────────────────────────────────────┐
         │              autotrade-web (PM2, Next.js)              │
         │                                                        │
         │   /api/status       /api/positions                     │
         │   /api/trade-history /api/config (mengenkripsi saat POST)│
         │                                                        │
         │   Dasbor (server components)                           │
         └────────────────────────────────────────────────────────┘
```

### Playbook SMC/ICT (`bot/src/strategy/smc.ts`)

1. **Struktur (`structure.ts`)** — menemukan swing highs/lows dan mengklasifikasikan tren sebagai BULLISH / BEARISH / RANGING. Mendeteksi **BOS** (Break of Structure) dan **CHoCH** (Change of Character) pada candle tertutup terakhir.
2. **Order Block (`orderBlock.ts`)** — menempatkan candle berwarna berlawanan terakhir yang sebelum impuls yang kuat menghasilkan BOS. Melacak apakah zona tersebut telah ter mitigasi.
3. **Fair Value Gap (`fvg.ts`)** — ketidakseimbangan tiga candle di mana shadow candle[i-2] dan candle[i] tidak tumpang tindih.
4. **Entri** — ketika BOS yang baru sesuai dengan tren DAN OB yang belum mitigasi (atau FVG yang belum terisi) berada antara harga saat ini dan swing sebelumnya, mesin mengeluarkan sinyal dengan `entryPrice` di tepi zona, `stopLoss` di luar zona (buffered ATR), `takeProfit` pada RR yang dikonfigurasi (default 1:2).
5. **Skor confidence** adalah 0..1; sinyal di bawah `minConfidence` (default 0,55) dicatat tetapi tidak dieksekusi.

Setiap sinyal yang terdeteksi disimpan ke tabel `Signal` terlepas dari apakah ia menghasilkan pesanan — itu merupakan dataset backtest Anda.

---

## 7. Di Mana untuk Diperluas

Boilerplate ini sengaja dibuat kecil. Iterasi berikutnya yang mungkin:

- **Konfluensi HTF**: baca struktur 4h, hanya perdagangkan sinyal 15m yang selaras dengan tren 4h.
- **Killzones**: filter waktu untuk sesi London/NY.
- **Sweep likuiditas**: hanya masuk setelah ada shadow yang menyapu swing high/low sebelumnya.
- **Trailing stop**: ganti TP statis dengan logika trailing yang menggeser SL.
- **Harness backtest**: replay candle historis melalui `SMCEngine.evaluate()` dalam loop.

Batas-batas bersih: setiap modul strategi adalah fungsi murni atas `Candle[]`, sehingga backtesting terutama tentang plumbing.

---

## 8. Catatan Keamanan

- **`ENCRYPTION_KEY`** hanya ada di `.env` pada VPS. Cadangkan secara offline. Jika kunci ini hilang, Anda harus memutar setiap kunci API yang tersimpan.
- **Izin kunci API Binance**: aktifkan *hanya* "Enable Futures". Jangan izinkan penarikan. Batasi dengan IP jika memungkinkan.
- **`DASHBOARD_API_TOKEN`** melindungi setiap rute `/api/*` melalui perbandingan token bearer yang aman terhadap timing.
- Dasbor bersifat single-user oleh desain. Jika Anda membutuhkan multi-user, ganti `requireAuth` dengan sesi yang sebenarnya dan letakkan di belakang reverse proxy dengan HTTPS (Caddy/Nginx + Let's Encrypt).
- Jangan meng-commit `.env` atau `prisma/*.db`.

---

## 9. Peta File

| Jalur | Tujuan |
|---|---|
| `prisma/schema.prisma` | Skema DB (BotConfig dengan kunci terenkripsi, Order, Trade, Position, Signal, EventLog) |
| `bot/src/shared/crypto.ts` | Enkripsi/dekripsi AES-256-GCM |
| `bot/src/websocket/binanceStream.ts` | Klien WS K-Line dengan reconnect + watchdog |
| `bot/src/strategy/structure.ts` | Deteksi swing, BOS, CHoCH |
| `bot/src/strategy/orderBlock.ts` | Deteksi OB + pelacakan mitigasi |
| `bot/src/strategy/fvg.ts` | Deteksi Fair Value Gap + pelacakan pengisian |
| `bot/src/strategy/smc.ts` | Orkesstrator sinyal (menggabungkan ketiga di atas) |
| `bot/src/execution/binanceClient.ts` | Klien REST yang ditandatangani + penjaga rate-limit |
| `bot/src/execution/riskManager.ts` | Sizing, penempatan pesanan braket |
| `bot/src/engine.ts` | Perekat: WS → strategi → eksekusi |
| `web/app/api/*` | Endpoint REST dasbor |
| `web/app/page.tsx` | UI Dasbor |
| `ecosystem.config.js` | Definisi proses PM2 |
