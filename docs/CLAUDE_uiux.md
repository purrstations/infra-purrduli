# CLAUDE.md — UI/UX Design (Purrtein Smart Cat Feeder)

> Dokumen ini adalah konteks utama untuk agent AI / desainer yang mengerjakan UI/UX. Baca seluruhnya sebelum mulai mendesain.
>
> **WAJIB BACA DULU:**
> - `CLAUDE_integration_contract.md` — error reason enum, state device, konstanta (cooldown, durasi stream, dll).
> - `CLAUDE_frontend.md` — daftar komponen wajib, halaman, dan state pattern (`packages/ui`, `<StreamPlayer>`, dll).
>
> Dokumen ini mengatur **visual + interaction**, bukan implementasi React. Tujuan: hand-off Figma → dev dengan minimal interpretasi.

---

## 1. Project Context

Purrtein Smart Cat Feeder = platform donasi remote untuk kasih makan kucing jalanan + tonton livestream. Dua aplikasi:

1. **User App** — Mobile-first PWA. Tone empatik, hangat, micro-aksi cepat. Audiens: donatur publik (mahasiswa, pekerja kota, pecinta kucing).
2. **Admin Dashboard** — Desktop. Tone fungsional, data-dense, no fluff. Audiens: admin operasional Purrtein + teknisi lapangan.

Karakter produk: **mission-driven**, bukan SaaS dingin. Donasi adalah aksi emosional — UI harus kasih *feedback hangat* setelah feeding sukses (animasi, copy yang tulus, foto kucing di feeder kalau ada).

---

## 2. Design Principles

1. **Hangat tapi cepat.** Bahasa ramah, tapi flow donasi ≤3 tap dari landing ke feeding sukses (kalau sudah login + saldo cukup).
2. **Mobile-first untuk user, desktop-first untuk admin.** Jangan paksakan parity layout.
3. **Setiap rupiah/token = aksi nyata.** Setelah feeding sukses → screen sukses besar, ada thumbnail kucing kalau stream aktif, dorongan share/feed lagi.
4. **Selalu jelaskan kondisi device.** Online / Offline / Stok rendah harus ke-baca di < 1 detik via warna + ikon, jangan cuma teks.
5. **Real-time tanpa flicker.** Update via WS = optimistic + skeleton, bukan spinner tengah layar. State final dalam ≤2 detik.
6. **Privasi pertama.** Stream livestream area publik = ada wajah orang lewat. UI wajib tampilkan disclaimer + signage virtual + tombol "Laporkan".
7. **Failure adalah kasih sayang.** Setiap error: token sudah dikembalikan (kalau berlaku), kasih tahu alasannya pakai bahasa manusia, kasih CTA "Coba feeder lain" / "Lapor admin".
8. **Aksesibilitas default WCAG AA.** Bukan tambahan. Kontras teks ≥4.5:1, semua fokus ring kelihatan, screen reader.

---

## 3. Audiens & Personas

### 3.1 Donatur Publik — "Citra, 26"
- Mahasiswa S2 di Jakarta, pecinta kucing, nabung Rp 50–100 rb/bulan untuk donasi.
- Akses HP Android mid-range (Pixel-class), 4G unstable di kost.
- Goal: kasih makan 1–3 kali per minggu, nonton stream sebentar, share ke teman.
- Pain: takut donasi sia-sia → butuh **bukti visual** (stream, foto, count "X kucing diberi makan hari ini").

### 3.2 Admin Operasional — "Rifki, 32"
- Tim ops Purrtein. Pegang 10–30 device sekaligus.
- Akses desktop / 2 monitor + HP untuk notifikasi.
- Goal: respon notifikasi cepat (stok habis, device offline), batch action (refill multi-device).
- Pain: terlalu banyak alert → butuh **filter + dedup + severity**.

### 3.3 Teknisi Lapangan — "Bayu, 40"
- Pasang/refill device. HP Android entry, satu tangan sibuk pegang feeder.
- Goal: pair device baru < 5 menit. Refill scan QR + confirm.
- Pain: koneksi MiFi di lokasi sering jelek → flow harus tahan latency tinggi + offline-tolerant.

---

## 4. Brand Foundation (Placeholder — D9 belum final)

Sampai brand kit dari Purrtein keluar, pakai placeholder berikut. Semua token taruh di `tailwind.config.ts` + `tokens.css` supaya gampang swap satu titik.

### 4.1 Voice

- **Singkat, akrab, tidak childish.** Pakai "kamu", bukan "Anda". Tidak pakai emoji di copy kecuali konteks emosional sukses.
- **Sebut "kucing" bukan "pet" / "hewan".** Brand inti.
- **Hindari teknis jargon.** "Stok pakan habis" bukan "stock_level < threshold".

### 4.2 Tone matrix

| Konteks | Tone | Contoh |
|---|---|---|
| Sukses feed | Hangat, syukur | "Mantap, satu mangkok terisi!" |
| Sukses topup | Apresiatif | "Terima kasih, saldo kamu sudah masuk." |
| Saldo habis | Suportif | "Saldo habis. Topup dulu yuk biar bisa beri makan." |
| Device offline | Jujur, tidak menyalahkan | "Feeder ini sedang offline. Coba feeder lain dulu." |
| Motor gagal | Empati + transparan | "Maaf, motor feeder error. Token kamu sudah dikembalikan, tim kami sudah diberitahu." |
| Refund | Lega | "Token sudah kembali ke saldo kamu." |
| Anti-abuse | Tegas tapi ramah | "Kamu baru saja kasih makan feeder ini. Coba lagi 5 menit lagi ya." |

---

## 5. Design Tokens

> **Source of truth = `packages/ui/tokens/`** (CSS variables + Tailwind config). Designer kerja di Figma dengan token names yang **sama persis** supaya dev tidak nebak.

### 5.1 Color

```
Primary (Purrtein Orange — placeholder)
  primary/50   #FFF3EE   bg muda
  primary/100  #FFE0D2
  primary/300  #FFAD8A
  primary/500  #FF7A59   ★ default brand
  primary/600  #E5613F   hover
  primary/700  #B84A2D   pressed
  primary/900  #5C2417   text on light

Surface
  surface/light   #FFF8F4
  surface/dark    #1F1612
  surface/card    #FFFFFF (light) / #2A1F1A (dark)

Neutral (Slate-based)
  neutral/50  #F8FAFC
  neutral/100 #F1F5F9
  neutral/300 #CBD5E1
  neutral/500 #64748B  body text muted
  neutral/700 #334155  body text default
  neutral/900 #0F172A  heading

Semantic
  success/500 #10B981   feed sukses
  warning/500 #F59E0B   stok rendah
  danger/500  #EF4444   device offline / error
  info/500    #3B82F6   notif info

Stream
  live/500    #DC2626   indicator "LIVE" dengan dot pulsing
```

**Aturan:**
- Background utama: `surface/light` di user app, `neutral/50` di admin.
- Kontras teks utama: `neutral/900` di atas surface light → rasio > 12:1 ✓.
- Primary 500 di atas white → 3.4:1 → **HANYA untuk large text (≥18px bold) atau ikon**. Untuk body link, pakai `primary/700`.
- Status color tidak boleh berdiri sendiri — selalu pasangan dengan ikon (color-blindness safe).

### 5.2 Typography

- Family: **Inter Variable** (fallback: `system-ui, -apple-system, sans-serif`).
- Display angka (saldo, counter): **`tabular-nums`** supaya angka tidak shifting saat update real-time.

| Style | Size / line-height / weight | Pakai untuk |
|---|---|---|
| Display-2xl | 36 / 44 / 700 | Saldo besar di Wallet |
| Display-xl | 30 / 38 / 700 | Heading hero landing |
| Heading-lg | 24 / 32 / 600 | Page title |
| Heading-md | 20 / 28 / 600 | Card title, modal heading |
| Heading-sm | 16 / 24 / 600 | Section header |
| Body-md | 16 / 24 / 400 | Body default |
| Body-sm | 14 / 20 / 400 | Secondary text, helper |
| Caption | 12 / 16 / 500 | Label badge, timestamp |
| Mono-sm | 13 / 18 / 500 | `request_id`, kode error |

Hindari pakai > 4 weight di satu screen.

### 5.3 Spacing (4-pt scale)

`0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96` (matches Tailwind 0–24).

Container padding mobile: `16px`. Desktop card: `24px`.

### 5.4 Radius

- `4` — pill badge
- `8` — input, button kecil
- `12` — button primer, card kecil
- `16` — card besar, modal
- `9999` — avatar, ikon bulat

### 5.5 Shadow

- `shadow/sm`: `0 1px 2px rgba(15,23,42,0.05)` — input
- `shadow/md`: `0 4px 12px rgba(15,23,42,0.08)` — card, dropdown
- `shadow/lg`: `0 12px 32px rgba(15,23,42,0.12)` — modal, sheet
- `shadow/primary`: `0 8px 24px rgba(255,122,89,0.25)` — primary CTA hover

### 5.6 Z-index scale

`base 0, dropdown 10, sticky 20, fixed 30, modal-backdrop 40, modal 50, popover 60, toast 70, tooltip 80`

### 5.7 Breakpoints (match Tailwind default)

- `sm` 640, `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536.
- **User app primary canvas: 375 (iPhone SE), 390 (iPhone 14), 412 (Pixel 7).** Test minimal 3.
- **Admin primary canvas: 1440 desktop, 1024 small laptop.** Mobile admin → readable, tidak fully featured.

---

## 6. Iconography

- Library: **lucide-react** (sudah include via shadcn). Ukuran default 20px, stroke 1.75.
- Custom icons (Purrtein-specific):
  - 🐾 paw (logo unit)
  - 🥣 bowl (feed action)
  - 📡 antenna with strikethrough (offline)
  - 🎥 with red dot (LIVE)
- Aturan: ikon selalu **didampingi label** kecuali konteks sangat jelas (mis. icon-only button di toolbar admin). Label = `aria-label` minimum.

---

## 7. Imagery & Illustration

- **Foto kucing**: pakai foto asli dari device. Phase 1 belum ada → pakai 3–5 stock placeholder (kucing jalanan Indonesia, bukan ras eksotis import) untuk landing.
- **Illustration empty state**: line-art simple, satu warna primary. Style mirip Linear/Notion empty state — bukan corporate flat 2.0.
- **Map markers**: SVG bulat dengan ikon 🐾, warna by status (hijau/abu/kuning).
- **Hindari foto bayi kucing oversaturated yang manipulatif.** Brand etis.

---

## 8. Component Inventory

> Setiap komponen di `packages/ui/` punya: Figma frame, Storybook story, Vitest test, dokumentasi prop. **Tidak boleh ada komponen yang dipakai di > 2 tempat tanpa masuk ke `packages/ui`.**

### 8.1 Atoms

| Komponen | Variants | Catatan |
|---|---|---|
| `<Button>` | primary, secondary, ghost, danger, link · sm/md/lg · loading state | Disabled state harus jelas (opacity 0.5 + cursor-not-allowed). Loading: spinner di kiri label. Tap target ≥44px |
| `<Input>` | text, password, number, search · with prefix/suffix icon · error state | Helper text di bawah, error text merah |
| `<Badge>` | online (success), offline (neutral), live (live/500 pulsing dot), low-stock (warning), error (danger) | Bentuk pill, ukuran sm |
| `<Avatar>` | size sm/md/lg · fallback initials | |
| `<StatusDot>` | hijau/kuning/merah/abu, opsi pulsing untuk live | |
| `<Skeleton>` | rect/circle/text | Animasi shimmer halus, jangan flashy |
| `<Toast>` (sonner) | success/error/info/warning | Posisi mobile: top, desktop: bottom-right |

### 8.2 Molecules

| Komponen | Catatan |
|---|---|
| `<StockIndicator level={0.72}>` | Progress bar 6px tinggi, warna by threshold (>0.5 hijau, 0.15–0.5 kuning, <0.15 merah). Label `% stok` di samping. Pakai `aria-valuenow` |
| `<StatusBadge device={...}>` | Composite: dot + label + last_seen relative time |
| `<TokenBalance balance={n}>` | `tabular-nums`, dengan ikon koin 🪙 (placeholder), animasi count-up saat berubah |
| `<FeederCard feeder={...}>` | Untuk peta bottom-sheet preview. Foto + nama + lokasi + status + stok + CTA |
| `<ConfirmModal>` | Title + body + CTA primary (confirm) + secondary (cancel). Backdrop blur, escape close |
| `<EmptyState illustration title body cta>` | Slot illustration kiri, copy + CTA kanan (desktop) atau stack (mobile) |
| `<ErrorState code message requestId retry>` | Error besar dengan `request_id` mono kecil, copy reason, tombol retry |

### 8.3 Organisms

| Komponen | Catatan |
|---|---|
| `<StreamPlayer deviceId>` | Aspect ratio 16:9, ada overlay "LIVE" badge top-left + control mute/fullscreen bottom-right. Loading skeleton dengan ikon kamera pulsing |
| `<FeederMap devices>` | Leaflet + cluster. Default zoom Jakarta 11. User location button opsional |
| `<FeedConfirmSheet feeder>` | Bottom sheet (mobile) / modal (desktop). Stepper rotations + estimasi + saldo + CTA |
| `<PackageCard package selected>` | Card paket topup. Highlight border primary kalau selected. Show "Hemat 10%" badge kalau ada |
| `<DeviceTableRow device>` | Admin row: nama + lokasi + status + stok + last_seen + action button |
| `<NotificationItem alert>` | Severity dot + judul + body + waktu + CTA "Lihat device" |
| `<PairingWizard>` | 4 step: form → QR display → polling → success/timeout |

### 8.4 Page templates

| Template | Pakai |
|---|---|
| `<AppShell>` (user) | Top bar saldo + avatar, bottom tab nav (Home / Riwayat / Wallet / Profil), main outlet |
| `<AdminShell>` (admin) | Side nav kiri, top bar notif bell + admin menu, main outlet, footer status broker (online/offline EMQX) |
| `<AuthLayout>` | Logo center, card 400px max, footer link |

---

## 9. Motion & Micro-interactions

Library: Tailwind transition + `framer-motion` untuk animasi kompleks. Default duration **150–250 ms**, easing `ease-out`.

| Aksi | Animasi |
|---|---|
| Button press | Scale 0.97 + shadow shrink, 100 ms |
| Modal open | Fade backdrop 200 ms + slide-up content 250 ms |
| Toast | Slide-in 200 ms, auto-dismiss 4 s (success), 6 s (error) |
| WS update saldo | Count-up tween 600 ms, ease-out |
| Feed sukses | Confetti subtle (sekali) + checkmark scale-in + haptic feedback mobile (`navigator.vibrate(50)`) |
| Stream loading | Pulsing camera icon, bukan spinner |
| Stock bar drop | Bar width animate 400 ms saat heartbeat baru |
| Device status flip online→offline | Dot color crossfade 300 ms, jangan blink keras |

**Reduced motion:** respect `prefers-reduced-motion: reduce` → matikan confetti, count-up jadi instant, transition tetap tapi 50 ms.

---

## 10. Information Architecture

### 10.1 User App — Bottom Tab Nav

```
[ Home / Peta ]   [ Riwayat ]   [ Wallet ]   [ Profil ]
       /              /history       /wallet     /profile
```

- Home selalu landing. Peta dominant viewport.
- Profil = settings + logout + tentang Purrtein.
- Detail feeder + Feed + Topup = full-screen (tanpa tab nav).

### 10.2 Admin — Side Nav

```
🏠 Dashboard
📡 Devices
🔔 Notifications
👤 Users
👮 Admins (super_admin only)
📋 Audit Log (super_admin only)
⚙️  Settings
─────
[logout]
```

Tab nav admin tetap visible saat drill-down (`/devices/:id`) → user tidak hilang context.

---

## 11. Key User Flows

### 11.1 Donor pertama kali (cold start)

```
Landing/Peta (publik)
   ↓ tap marker
Detail Feeder (publik, livestream butuh login)
   ↓ tap "Beri Makan"
Auth Login (atau Register kalau belum)
   ↓ sukses login → redirect back ke /feeder/:id/feed
Feed Confirm (saldo 0 → tombol "Topup")
   ↓ Topup
Pilih Paket → Pilih Metode → Xendit
   ↓ bayar di Xendit
Redirect /topup/pending → WS token.credited
   ↓ auto redirect ke /feeder/:id/feed
Feed Confirm (saldo cukup)
   ↓ konfirmasi → POST /feed 202
Feeding Loading (skeleton + "Sedang memberi makan…")
   ↓ WS feeding.done
Feed Success Screen 🎉 (thumbnail stream kalau aktif, CTA "Lihat live" / "Feed lagi" / "Lihat riwayat")
```

**Target: < 90 detik dari landing → feed sukses (asumsi pembayaran QRIS instan).**

### 11.2 Donor returning

```
Landing → tap marker → tap "Beri Makan" → konfirm → sukses.
```

**Target: < 15 detik.**

### 11.3 Admin respond stok habis

```
WS push notif → klik notif → /admin/devices/:id
→ konfirmasi visual stok 0 di stream → assign teknisi via WhatsApp (Phase 1 manual)
→ teknisi refill → admin klik Refill button → WS update stock_level = 1.0
```

### 11.4 Teknisi pasang device baru

```
Admin: /devices/new wizard
→ Form lokasi → backend create → QR + secret tampil sekali
Teknisi (mobile app, Phase 1 dummy / serial console):
→ Scan QR → BLE connect → kirim WiFi cred
Device: PROVISIONING → CONNECTING → IDLE → publish boot event
Admin wizard polling: pairing-status → online → screen sukses
```

---

## 12. Page-by-Page Spec — User App

> **Konvensi spec:** Setiap halaman punya:
> - **Layout:** sketch wireframe
> - **Data:** query keys yang dipakai
> - **States:** loading / empty / error / offline / success
> - **Real-time:** WS event yang relevan
> - **CTA primer + sekunder**

### 12.1 `/` — Landing / Peta

**Layout (mobile):**
```
┌──────────────────────┐
│ ☰ Purrtein   🐾 Login│  ← top bar 56px, transparan over map
├──────────────────────┤
│                      │
│       [PETA]         │  ← full bleed
│   🐾   🐾  🐾        │
│         🐾           │
│                      │
│  ┌────────────────┐  │
│  │ 12 feeder aktif│  │ ← floating chip
│  └────────────────┘  │
└──────────────────────┘
   [tab nav]
```

Marker tap → bottom sheet preview `<FeederCard>` (50% viewport) → "Lihat detail".

**Data:** `useQuery(['devices'])`.

**States:**
- Loading: full map dengan skeleton 3 marker placeholder.
- Empty (0 device): illustration + "Belum ada feeder. Cek lagi nanti."
- Error: full-screen error + tombol retry.
- Offline (browser): banner top "Mode offline — data mungkin tidak terbaru."

**Real-time:** WS `device.status` → marker color update tanpa reload.

### 12.2 `/feeder/:id` — Detail Feeder

**Sections (mobile, stacked):**
1. Header (nama + lokasi + back button)
2. `<StreamPlayer>` 16:9 — kalau belum login, overlay "Login untuk lihat live" + CTA
3. Status badge row: `<StatusBadge>` + `<StockIndicator>` + "X kucing diberi makan hari ini"
4. CTA besar `<Button variant="primary" size="lg">🥣 Beri Makan</Button>` — disabled kalau offline, tambah helper text
5. Footer: lokasi map mini + alamat lengkap + "Lapor masalah"

**Data:** `useQuery(['device', id])`, `useQuery(['device', id, 'stream'])`.

**States:**
- Device offline: stream placeholder "Feeder offline" + CTA disabled + "Coba feeder lain" link ke `/`.
- Stream tidak aktif: placeholder "Stream sedang tidak aktif" + opsi (kalau admin) Start; user biasa = info aja.
- Stock empty: badge merah + tombol disabled + "Stok habis. Coba feeder lain."

**Real-time:** `device.status`, `device.stream`, `feeding.done` (counter "X kucing").

### 12.3 `/feeder/:id/feed` — Konfirmasi Feeding

**Layout:**
```
← Kembali

Beri Makan di {feeder.name}

Saldo kamu: 🪙 12 token

[ Jumlah porsi: [-] 1 [+] ]   ← stepper, max 5
≈ 10–15 gram pakan
Biaya: 🪙 1 token

[ 🥣 Konfirmasi Beri Makan ]   ← primary big

ⓘ Token akan dikembalikan otomatis kalau feeder gagal.
```

Saldo < cost → tombol jadi `[ Topup Dulu ]` redirect ke `/topup?from=/feeder/:id/feed`.

**Live transitions:**
- Klik konfirm → tombol disabled, label jadi "Sedang dikirim…", skeleton bar.
- WS `feeding.queued` → "Permintaan diterima, menunggu feeder…"
- WS `feeding.done completed` → full-screen success.
- WS `feeding.failed` → toast + UI kembali idle, saldo refresh.

### 12.4 Feed Success Screen

```
       ✓
   Mantap!
Satu mangkok sudah terisi.

[ Thumbnail livestream sekarang ]
   "Mau lihat kucing makan?"
   [ 📺 Tonton Live ]

[ 🥣 Beri Makan Lagi ]
[ 📋 Lihat Riwayat ]
```

Confetti subtle sekali. Haptic mobile.

### 12.5 `/topup`

```
Pilih Paket

[ Card paket 1 ]
[ Card paket 2 ] ← popular badge
[ Card paket 3 ]

Pilih Metode Bayar
[ ◉ QRIS  ]
[ ○ VA BCA ]
[ ○ OVO   ]
[ ○ GoPay ]

[ Bayar Rp 50.000 ]   ← sticky bottom kalau ada selected
```

### 12.6 `/topup/pending`

Center stage:
```
   ⏳
Menunggu konfirmasi pembayaran…

Kode: topup-xxxx-yyyy

[ Cek manual: Lihat Riwayat Topup ]
```

WS `token.credited` → redirect `/wallet?credited=topup_id` dengan toast.
Timeout 5 menit → "Cek riwayat untuk status terkini" + CTA.

### 12.7 `/wallet`

```
Saldo
🪙 24 token

[ + Topup ]

[ Tabs: Topup | Pemakaian ]

[ List item: 2026-06-21  +10 token  Rp 50.000  ✓ Sukses ]
[ List item: 2026-06-20  -1 token   Feeder Sudirman 1 ]
[ List item: 2026-06-20  +1 token   Refund: motor error ]
...
```

### 12.8 `/history`

Per feeding: thumbnail device + nama + waktu + status (Sukses / Gagal — refund). Filter tanggal.

### 12.9 `/auth/login` & `/auth/register`

Layout simple, brand logo center, card 360–400 px. Sosial login (D1 belum final) → skip Phase 1. Forgot password → email manual (Phase 1 disclaimer).

---

## 13. Page-by-Page Spec — Admin Dashboard

### 13.1 `/` — Dashboard Summary

Top row: **4 stat cards** (Total device, Online, Stok rendah, Feeding hari ini).
Mid: Tabel device (10 row preview) dengan filter.
Right column (desktop ≥1440): **Live activity feed** (WS event stream — terbaru di atas, max 20).

### 13.2 `/devices` — Tabel Device

Sticky header. Sort by `last_seen`. Filter: status (All/Online/Offline), stok rendah toggle. Pagination 50/halaman.

Row: avatar + nama + lokasi + `<StatusBadge>` + `<StockIndicator>` (kompak) + last_seen relative + action button.

Action button: dropdown `[ Detail | Start Stream | Refill | Reset Secret ]`.

### 13.3 `/devices/:id` — Detail Device

Layout 2-kolom desktop, 1-kolom mobile:

**Kiri (60%):**
- Header: nama, lokasi, status badge, button [Start/Stop Stream].
- `<StreamPlayer>` (kalau stream aktif).
- Quick stats: Stok, Total rotasi, Firmware version, Last seen, RSSI, Uptime.
- Action panel: [Refill] [Reset Secret] [Edit Lokasi] [Pause Maintenance].

**Kanan (40%):**
- Tab: `Device Logs` | `Feeding Logs` | `Stream History`.
- Live append via WS.

### 13.4 `/devices/new` — Pairing Wizard

4-step horizontal stepper:

```
[ ① Info ] → [ ② QR ] → [ ③ Tunggu ] → [ ④ Sukses ]
```

**Step ① Info:** form name + lokasi (map picker pakai react-leaflet).
**Step ② QR:** generate QR berisi `{device_id, device_secret, mqtt_host}`. Tampil + tombol Print/Download. **Banner kuning besar:** "Secret hanya muncul sekali. Simpan QR sebelum lanjut."
**Step ③ Tunggu:** polling pairing-status. Live status: "Mencari device… (1m 23s)". Timeout 15 menit → "Coba reset device + scan ulang".
**Step ④ Sukses:** centang besar + "Device online" + CTA `[ Lihat Device ]`.

### 13.5 `/notifications`

Grouped by hari. Filter severity. Tap notif → drill ke device.

---

## 14. State Patterns

### 14.1 Loading

- **First load:** skeleton sesuai layout (bukan spinner full-screen).
- **Mutation in flight:** disable tombol + spinner di kirinya. Hindari skeleton pada area yang sedang user lihat — bikin disorientasi.
- **Background refetch:** indikator halus (top progress bar 2 px, primary color) — *tidak* mengganggu layout.

### 14.2 Empty

Selalu pakai `<EmptyState>` dengan: illustration, judul ramah, body singkat, **CTA satu** (utama).

Contoh:
- `/history` kosong: "Belum ada riwayat. Yuk mulai beri makan kucing!" [ Cari Feeder ]
- `/wallet/history` kosong: "Belum pernah topup. [ Topup Sekarang ]"
- Admin `/notifications` kosong: 🎉 "Tidak ada notifikasi. Semua feeder aman."

### 14.3 Error

Layered:

| Level | Pakai |
|---|---|
| Field-level | Inline merah di bawah input |
| Action-level | Toast `<Toast variant="error">` |
| Page-level | `<ErrorState>` full block, tombol retry, opsi "Lapor: {request_id}" |
| Global / boundary | Error boundary fallback dengan reload page |

Untuk feed errors (refund flow): toast dengan `REASON_LABEL` (lihat `CLAUDE_frontend.md`). **Jangan tampilkan kode mentah** ke user.

### 14.4 Offline browser

Banner sticky top kuning: "Koneksi terputus. Beberapa fitur mungkin tidak berfungsi." Disable mutation buttons. Cache last `useQuery` data terlihat (TanStack Query persist opsional Phase 2).

### 14.5 Cooldown

User sudah baru feed device sama < 5 menit → tombol disabled dengan countdown:
```
[ ⏱ Tunggu 3:42 lagi ]
```

### 14.6 Refund visualisasi

WS `feeding.failed` arrive → toast sukses warna info (bukan merah keras): "Token sudah kembali ke saldo kamu (alasan: …)" + dropdown "Detail" expand reason.

### 14.7 Real-time update tanpa flicker

- **Counter saldo:** count-up animation 600 ms.
- **Status dot:** crossfade color, dot tetap di posisi.
- **Tabel admin:** debounce 100 ms, fade-in row baru.
- **Stream player:** thumbnail blur sampai frame pertama datang.

---

## 15. Accessibility

WCAG 2.1 AA mandatory.

- Kontras text ≥4.5:1 normal, ≥3:1 large/icon.
- Semua interaktif punya `aria-label` atau visible label.
- Focus ring **selalu visible** (2px primary, offset 2px).
- Tab order match visual order. Modal trap focus.
- Form error pakai `aria-describedby` ke error text + `aria-invalid`.
- Live region untuk WS update penting (`aria-live="polite"` untuk saldo, `assertive` untuk error feed).
- Screen reader test: VoiceOver iOS + TalkBack Android + NVDA Windows minimal di flow login + feed.
- Tap target ≥44×44 px.
- Tidak ada info hanya lewat warna (selalu icon/label tambahan).
- `prefers-reduced-motion` honored.

CI: `@axe-core/playwright` jalan di Playwright e2e — block PR kalau ada violation.

---

## 16. Responsive Behavior

| Breakpoint | User App | Admin |
|---|---|---|
| < 640 | Default canvas | Stack semua kolom, side nav jadi hamburger drawer |
| 640–1023 | Optimasi tablet (lebar konten max 600) | Side nav collapsible icon-only |
| 1024–1279 | Center max-width 720 | Side nav full + 2-kolom konten |
| ≥ 1280 | Center max-width 720 (tidak melebar) | Side nav full + 3-kolom (admin detail device) |

User app: **jangan paksa stretch full-width di desktop.** Konten lebar 720 max, sisanya background. Lebih nyaman dibaca.

---

## 17. Dark Mode

Default: ikut system (`prefers-color-scheme`). Toggle manual di Profil/Settings.

Aturan transition:
- Surface light → dark crossfade 200 ms saat toggle, tapi muat-pertama kali = instan (no flash).
- Brand primary 500 tetap sama (good contrast on both).
- Bayangan dark mode pakai `rgba(0,0,0,0.4)` (lebih dalam).
- Image dengan background transparan — pastikan tidak menempel ke surface dark.

---

## 18. Privacy & Etika UX

- **Disclaimer kamera:** banner sekali di Detail Feeder pertama kali user nonton stream: "Kamera ini merekam area publik. Stream tidak disimpan." [ Mengerti ] [ Privacy Policy ].
- **No record button** — tegaskan tidak ada fitur record (di Phase 1 mediamtx config `record: false`).
- **Report button** kecil di stream overlay: "Lapor masalah" → form (privasi, konten, teknis) ke admin.
- **Data download / hapus akun**: link di Profil → mailto ke privacy@purrtein (Phase 1 manual).

---

## 19. Copywriting Lexicon (Bahasa Indonesia)

Konsistensi istilah:

| Konsep | Istilah resmi |
|---|---|
| Smart Feeder | "Feeder" (capital F kalau jadi nama produk, lowercase di kalimat) |
| Pakan | "pakan" (bukan "makanan kucing", lebih netral) |
| Action feeding | "beri makan" / "kasih makan" — keduanya OK, konsisten di satu halaman |
| Token | "token" (lowercase, jamak tanpa "s") |
| Topup | "topup" (satu kata) — bukan "isi ulang" supaya keep brand internet-savvy |
| Donatur | "donatur" — di copy emosional. "Kamu" di CTA |
| Refund | "dikembalikan" — hindari "refund" di copy user-facing |
| Online/offline device | "aktif" / "tidak aktif" — lebih friendly daripada teknis |
| Stream | "siaran langsung" / "live" — keduanya OK |

---

## 20. Design Hand-off

- **Figma project** (link di README, kalau ada):
  - File 1: `Foundations` — tokens, type scale, color, components.
  - File 2: `User App` — flows + screens.
  - File 3: `Admin Dashboard` — flows + screens.
  - File 4: `Prototyping` — interactive prototype untuk usability test.
- **Storybook** di `apps/storybook/` — semua komponen `packages/ui` punya story (default + variants + states).
- **Design tokens** sync: pakai `style-dictionary` atau `Tokens Studio` plugin Figma → export ke `tokens.json` → konsumsi di Tailwind config + Figma. **Satu sumber.**
- **Naming convention** komponen Figma = sama dengan React (`Button/Primary/Medium`).
- **Annotation di Figma**: spacing pakai `[gap]`, redline minimal — pakai Dev Mode.

---

## 21. TDD untuk Design (Usability)

Sebelum dev mulai implement screen baru — **lulus usability test 3 user minimum**.

### 21.1 Pre-launch checklist per halaman

- [ ] Wireframe direview tim
- [ ] Hi-fi mockup direview Purrtein
- [ ] Prototyping Figma diklik 3 user (5–10 menit moderated)
- [ ] Issue logged + prioritized
- [ ] Storybook story dibuat
- [ ] a11y axe scan pass
- [ ] Lighthouse desktop + mobile pass (≥85 perf, 100 a11y)

### 21.2 Visual regression

- Playwright snapshot key screens.
- Chromatic / Percy untuk Storybook (opsional).

### 21.3 Metrik UX yang dilacak

- Time-to-first-feed (cold start)
- Drop-off di tiap step topup
- Stream play success rate (frame pertama < 5 detik)
- Error toast frequency by reason
- a11y violations / 1000 page view (Sentry custom)

---

## 22. Open Decisions (UI/UX)

Sinkron dengan `CLAUDE_integration_contract.md §15`.

| ID | Pertanyaan | Default sementara |
|---|---|---|
| **U1** | Brand kit (logo, palette final, font) | Placeholder orange + Inter sampai keluar |
| **U2** | Mascot? (paw illustrated) | TBD — sketsa eksplor saat brand kit |
| **U3** | Apakah ada landing marketing page sebelum peta? | Tidak (Phase 1). Peta langsung jadi landing |
| **U4** | Share feeder ke sosmed (link + image preview)? | Phase 2 (butuh OG image generator) |
| **U5** | Apakah donor diberi badge / level berdasarkan total feed? | Phase 2 (gamification) |
| **U6** | Multilanguage EN? | Phase 2 |
| **U7** | Dark mode default atau opt-in? | Ikut system (auto) |
| **U8** | Detail device — tampil foto kucing yang pernah datang? | TBD (butuh AI detection Phase 3) |
| **U9** | Sound feedback feed sukses? | Opt-in di settings, default off |
| **U10** | Map style (OSM default vs custom Mapbox)? | OSM default Phase 1 (gratis) |

---

## 23. Disaster Checklist Spesifik UI/UX

- ❗ **Stream loading > 5 detik tanpa feedback** → user kira broken. Wajib skeleton + progress message.
- ❗ **Saldo tidak update setelah feed** → user spam klik. WS event → optimistic decrement + invalidate.
- ❗ **Tombol feed kelihatan aktif padahal device offline** → frustasi user. Wajib disable + helper text.
- ❗ **Modal tidak trap focus** → keyboard user nyasar. Pakai shadcn Dialog (Radix sudah handle).
- ❗ **Toast stack** kalau backend spam error → user banjir. Limit max 3 di layar, dedup by code.
- ❗ **Confetti di mobile lemah perform** → drop frame, hp panas. Throttle ke 60 partikel + skip kalau low-end (deteksi via `navigator.deviceMemory < 4`).
- ❗ **QR pairing terlalu kecil di print** → tidak ke-scan. Min 300×300 px display + printable PDF 60×60 mm.
- ❗ **Dark mode flash on first paint (FOUC)** → ganggu mata. Set theme di `<head>` inline script sebelum React hydrate.
- ❗ **Touch target overlap** di list device admin → tap action salah. Spacing antar tombol ≥8 px, action di dropdown bukan inline button banyak.
- ❗ **Map zoom default terlalu jauh** → marker numpuk jadi blur. Default zoom Jakarta = 11, fit bounds kalau ada cluster pertama.
- ❗ **Form input nomor di mobile** → keyboard alpha keluar. Pakai `type="number" inputmode="numeric" pattern="[0-9]*"`.
- ❗ **Long device name overflow** → layout pecah. Truncate dengan `text-ellipsis`, tooltip on hover/long-press untuk teks penuh.
- ❗ **Refund toast hilang sebelum user baca** → user kira saldo nyangkut. Refund toast = 8 detik (bukan 4 default).
- ❗ **Copy "gagal" tanpa konteks** → user marah. Selalu sertakan alasan + apa yang sudah dilakukan (token kembali) + apa yang user bisa lakukan.
