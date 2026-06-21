# CLAUDE.md — Frontend (Purrtein Smart Cat Feeder)

> Dokumen ini adalah konteks utama untuk agent AI yang mengerjakan implementasi frontend. Baca seluruhnya sebelum mulai coding.
>
> **WAJIB BACA DULU:** `CLAUDE_integration_contract.md` — semua schema payload, error code, WebSocket event, dan konstanta ditentukan di sana. Dokumen ini hanya implementasi sisi frontend.

---

## Project Context

Dua aplikasi:

1. **User App** — Mobile-first PWA untuk publik (donasi, feed, livestream, peta).
2. **Admin Dashboard** — Desktop web untuk admin internal (monitoring device, kontrol stream, pairing device baru, notif).

Keduanya consume REST + WebSocket dari backend Purrtein.

---

## Tech Stack (Final — D8 resolved)

| Hal | Pilihan |
|---|---|
| Framework | **Next.js 14** (App Router) — SSR landing/peta untuk SEO, SPA-mode untuk halaman user-logged-in |
| Styling | Tailwind CSS + `clsx` + `tailwind-merge` |
| UI Primitives | shadcn/ui (Radix-based) |
| Server state | **TanStack Query (React Query) v5** |
| Client state | **Zustand** (auth UI state, notif local, modal) |
| HTTP client | **Axios** (interceptors auth refresh) |
| WebSocket | **socket.io-client** v4 |
| Form | `react-hook-form` + `zod` (sama schema dengan backend) |
| Peta | `leaflet` + `react-leaflet` v4 (atau `maplibre-gl` kalau butuh vector tiles) |
| WebRTC Player | Native `RTCPeerConnection` via WHEP (no library) |
| Payment | Xendit hosted invoice (redirect) |
| Auth storage | httpOnly cookie (set oleh backend) — frontend TIDAK akses JWT |
| i18n (Phase 2) | `next-intl` — Phase 1 hardcode `id-ID` |
| Date/Time | `date-fns` + `date-fns-tz` (display UTC → WIB) |
| Notif lokal | `sonner` (toast) |
| Testing | **Vitest + React Testing Library + MSW + Playwright** |
| Error reporting | Sentry |
| Analytics | Plausible (privacy-friendly) — opsional |
| Bundle analyzer | `@next/bundle-analyzer` di CI |

> 2 aplikasi di-deploy sebagai monorepo (Turborepo) dengan shared package `@purrtein/ui`, `@purrtein/api-client`, `@purrtein/schemas`.

---

## Struktur Monorepo

```
frontend/
├── apps/
│   ├── user/              # Next.js — user app
│   └── admin/             # Next.js — admin dashboard
├── packages/
│   ├── ui/                # shared shadcn components
│   ├── api-client/        # axios + react-query hooks + zod schemas
│   ├── schemas/           # zod (mirror backend + contract)
│   ├── ws-client/         # socket.io wrapper + typed events
│   └── stream-player/     # <StreamPlayer> WHEP component
├── contracts/             # JSON example payloads (di-share dari root contracts/)
└── turbo.json
```

---

## Routing

### User App (`apps/user`)

```
/                    → Landing + peta semua feeder aktif (public)
/feeder/:id          → Detail feeder + livestream (login dipakai untuk stream — D2)
/feeder/:id/feed     → Konfirmasi feeding (wajib login)
/topup               → Pilih paket + metode bayar
/topup/pending       → Polling/WS wait pembayaran
/wallet              → Saldo + riwayat
/history             → Riwayat feeding (wajib login)
/auth/login          → Login
/auth/register       → Register
/auth/forgot         → Forgot password (Phase 1 manual)
/legal/tos           → Terms of Service
/legal/privacy       → Privacy Policy
```

### Admin Dashboard (`apps/admin`)

```
/login                       → Admin login
/                            → Dashboard: tabel + ringkasan
/devices                     → Tabel device + filter
/devices/new                 → Wizard tambah device (BLE pairing instruksi + QR)
/devices/:id                 → Detail: log, stream control, refill button
/devices/:id/pair            → Pairing-status poll page (real-time)
/notifications               → Riwayat alert
/users                       → List user (super_admin)
/admins                      → Manage admin (super_admin)
/audit                       → Audit log (super_admin)
/settings                    → Constants viewer (read-only) — dari `/config/public`
```

---

## API Client

```
NEXT_PUBLIC_API_BASE_URL=https://api.purrtein.com/api/v1
NEXT_PUBLIC_WS_URL=https://api.purrtein.com
NEXT_PUBLIC_SENTRY_DSN=...
```

`packages/api-client/src/index.ts`:

```ts
export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_BASE_URL,
  withCredentials: true,  // kirim cookie httpOnly
  timeout: 10_000,
});

let isRefreshing = false;
let pendingQueue: Array<(t?: Error) => void> = [];

api.interceptors.response.use(null, async (err: AxiosError) => {
  const original = err.config!;
  if (err.response?.status === 401 && !original._retry) {
    if (isRefreshing) {
      await new Promise<void>((resolve, reject) => {
        pendingQueue.push((e) => (e ? reject(e) : resolve()));
      });
      return api(original);
    }
    original._retry = true;
    isRefreshing = true;
    try {
      await api.post('/auth/refresh');
      pendingQueue.forEach((cb) => cb());
      pendingQueue = [];
      return api(original);
    } catch (e) {
      pendingQueue.forEach((cb) => cb(e as Error));
      pendingQueue = [];
      window.location.href = '/auth/login';
      throw e;
    } finally {
      isRefreshing = false;
    }
  }
  throw err;
});
```

**`request_id` propagation:** generate UUID v4 di setiap request, kirim sebagai `X-Request-ID` header — backend echo balik. Pakai untuk error reporting (display ke user di toast "kode: …", supaya support bisa cari log).

---

## Auth Flow

1. `POST /auth/login` → backend set 2 httpOnly cookie (`access`, `refresh`). Frontend tidak baca cookie.
2. `GET /auth/me` → profile, dipakai untuk hydrate auth state Zustand.
3. Axios interceptor 401 → silent refresh → retry.
4. Logout: `POST /auth/logout` → server hapus cookie + invalidate refresh → frontend clear Zustand + invalidate React Query.

**Auth boundary di Next.js App Router:** pakai middleware `apps/user/middleware.ts` yang cek cookie `access` presence (no decode). Route butuh login → redirect ke `/auth/login?from=...`. Validasi penuh ada di backend; middleware hanya fast-path.

```ts
// middleware.ts
const PROTECTED = [/^\/feeder\/.+\/feed/, /^\/wallet/, /^\/history/, /^\/topup/];
export function middleware(req: NextRequest) {
  if (PROTECTED.some((re) => re.test(req.nextUrl.pathname))) {
    if (!req.cookies.get('access')) {
      const url = new URL('/auth/login', req.url);
      url.searchParams.set('from', req.nextUrl.pathname);
      return NextResponse.redirect(url);
    }
  }
}
```

---

## Halaman & Komponen Inti

### 1. Home — Peta Feeder

- SSR (data fetched at build atau ISR 60s) — supaya SEO + cepat di mobile network jelek.
- React-Leaflet + OpenStreetMap tiles.
- Marker: hijau (online), abu (offline), kuning (stock_low).
- Click marker → bottom sheet preview → CTA "Detail".
- **Performance:** cluster marker (>50 device) via `react-leaflet-cluster`.

### 2. Detail Feeder

Data: `GET /devices/:id` + `GET /devices/:id/stream`.

UI:
- Header: nama, lokasi, status badge.
- `<StockIndicator level={0.72}>` — progress bar warna gradient + label "% stok".
- `<StreamPlayer whepUrl streamToken expiresAt>` (lihat di bawah).
- CTA "Beri Makan" — disabled saat `device.status !== 'online'` atau saldo 0.
- Footer: jumlah feeding hari ini (aggregate dari backend).

### 3. Konfirmasi Feeding (`/feeder/:id/feed`)

Flow:
1. `GET /tokens/balance` (cached 30s).
2. `GET /config/public` → ambil `ROTATIONS_PER_TOKEN`, `MAX_ROTATIONS_PER_REQUEST`.
3. UI: slider/stepper `rotations: 1..MAX` → tampil "estimasi pakan: ~X gram" + "biaya: N token".
4. Saldo < N → tombol "Topup".
5. Konfirmasi → `POST /feed { device_id, rotations: N }`.
   - 202 → set local state "queued", subscribe WS event `feeding.queued`, `feeding.done`, `feeding.failed`.
6. WS `feeding.done` `status='completed'` → success screen, invalidate balance, invalidate `feed/history`.
7. WS `feeding.failed` → tampil reason yang user-friendly (map enum → bahasa). Token auto-refunded.

**Error mapping:**
```ts
const REASON_LABEL: Record<string, string> = {
  motor_stall: "Motor gagal, token dikembalikan. Admin akan diberitahu.",
  insufficient_stock: "Stok pakan habis. Token dikembalikan.",
  busy_streaming: "Feeder sedang ditonton, coba lagi 1 menit.",
  busy_feeding: "Feeder sedang memberi makan kucing lain. Coba lagi sebentar.",
  command_expired: "Permintaan kadaluwarsa. Coba ulang.",
  invalid_payload: "Permintaan tidak valid. Hubungi support.",
  time_not_synced: "Feeder belum siap. Coba 1 menit lagi.",
  device_offline: "Feeder offline.",
};
```

**Anti-double-submit:** disable tombol setelah klik, idempotency key dari `feeding_log_id` server-generated. Tampilkan toast "permintaan sedang diproses".

### 4. Topup (`/topup`)

1. `GET /tokens/packages` → render card list.
2. Pilih paket → pilih metode (D3 — default: tampilkan QRIS + VA BCA + e-wallet OVO, dropdown user-selectable).
3. `POST /tokens/topup { package_id, payment_method }` → `payment_url`.
4. `window.location.href = payment_url` (Xendit hosted).

### 5. Pending (`/topup/pending`)

- Read `?ext=` param (Xendit redirect back).
- Subscribe WS `token.credited`, `topup.failed`.
- Fallback: poll `GET /tokens/history?status=pending` setiap 5 detik.
- Timeout 5 menit → "Cek riwayat di /wallet".

### 6. Wallet

- `GET /tokens/balance` (live update via WS `token.credited` / `token.debited`).
- `GET /tokens/history` — infinite scroll.

### 7. Admin Dashboard

- Tabel device — server-side paginated. Sort by `last_seen`.
- Real-time update via WS `device.status`, `device.alert`.
- Indikator notifikasi baru di top bar (badge count).

### 8. Detail Device Admin

- Status, log, kontrol.
- **Start/Stop Stream**: tombol toggle. State: `inactive` → `starting` (disable button) → `active` (tombol jadi Stop) → `stopped`.
- Stream player preview saat `active`.
- **Refill button**: confirm modal → `POST /admin/devices/:id/refill` → WS update `device.status` dengan stock_level = 1.0.
- **Reset secret**: confirm 2x → modal tampil new secret + QR (sekali, tidak bisa di-fetch ulang).
- Stock alert badge kalau `< stock_threshold`.

### 9. Add Device Wizard (`/devices/new`)

Flow BLE pairing (lihat contract §8):
1. Step 1 (form): name, location_label, lat/lng (pakai map picker).
2. Step 2: backend create → return `{device_id, device_secret}`. Tampilkan **QR code** berisi JSON config + warning "secret hanya muncul sekali".
3. Step 3: instruksi teknisi — "Power on device, scan QR via mobile app Purrtein".
4. Step 4: polling `GET /admin/devices/:id/pairing-status` setiap 3s sampai `status === 'online'` (timeout 15 menit → "Coba reset").

> Mobile app native (bukan web) yang sebenarnya kirim BLE — admin dashboard cuma menampilkan QR. **Phase 1:** mobile app belum ada → fallback: serial console / tools/provision.sh manual + QR sebagai info.

---

## WebRTC Livestream (WHEP)

`packages/stream-player/StreamPlayer.tsx`:

```tsx
export function StreamPlayer({ deviceId }: { deviceId: string }) {
  const { data, refetch } = useQuery({
    queryKey: ['stream', deviceId],
    queryFn: () => api.get(`/devices/${deviceId}/stream`).then(r => r.data),
    refetchInterval: (q) => {
      const exp = q.state.data?.expires_at;
      if (!exp) return false;
      const msLeft = new Date(exp).getTime() - Date.now();
      return Math.max(5_000, msLeft - 10_000); // refresh 10s before expiry
    },
  });
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection>();

  useEffect(() => {
    if (!data?.whep_url || data.status !== 'active') return;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pcRef.current = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.ontrack = (e) => { if (videoRef.current) videoRef.current.srcObject = e.streams[0]; };

    (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await fetch(data.whep_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: offer.sdp!,
      });
      if (!res.ok) throw new Error('WHEP failed');
      const sdp = await res.text();
      await pc.setRemoteDescription({ type: 'answer', sdp });
    })().catch((e) => { Sentry.captureException(e); });

    return () => pc.close();
  }, [data?.whep_url]);

  if (!data) return <Skeleton/>;
  if (data.status !== 'active') return <StreamPlaceholder status={data.status}/>;
  return <video ref={videoRef} autoPlay playsInline muted className="w-full rounded-lg"/>;
}
```

**Penting:**
- `playsInline muted` — iOS Safari autoplay butuh muted.
- Cleanup `pc.close()` saat unmount → mencegah memory leak + bandwidth bleed.
- Periodic refetch URL sebelum `expires_at` (signed token TTL 60s).
- Heartbeat tab: kalau tab tidak focused > 30s → close PC, restart on focus (hemat bandwidth + biaya user).

---

## WebSocket Client

`packages/ws-client/`:

```ts
const socket = io(process.env.NEXT_PUBLIC_WS_URL!, {
  withCredentials: true,
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

type Events = {
  'device.status': { device_id: string; status: string; stock_level: number; total_rotations: number; updated_at: string };
  'device.alert':  { device_id: string; type: string; message: string };
  'device.stream': { device_id: string; state: string; whep_url?: string };
  'feeding.queued': { feeding_log_id: string; device_id: string };
  'feeding.done':  { feeding_log_id: string; device_id: string; status: string; rotations: number };
  'feeding.failed': { feeding_log_id: string; device_id: string; reason: string; token_refunded: boolean };
  'token.credited': { balance: number; topup_id: string };
  'token.debited': { balance: number; reason: string };
  'topup.failed': { external_id: string; reason: string };
};

export function useWS<E extends keyof Events>(event: E, handler: (p: Events[E]) => void) {
  useEffect(() => {
    socket.on(event, handler as any);
    return () => { socket.off(event, handler as any); };
  }, [event, handler]);
}
```

**Reconnect strategy:** saat reconnect, panggil `queryClient.invalidateQueries({queryKey: ['device-status']})` dll untuk sync ulang state yang terlewat (server tidak replay event).

**Idempotency:** event bisa double — gunakan `feeding_log_id` sebagai dedup key di reducer; tolak jika status sudah final.

---

## React Query Strategy

| Resource | staleTime | cacheTime | refetch on focus |
|---|---|---|---|
| `/devices` (peta) | 30s | 5min | yes |
| `/devices/:id` | 30s | 5min | yes |
| `/tokens/balance` | 5s | 5min | yes — tapi disabled saat WS connected |
| `/tokens/packages` | 5min | 30min | no |
| `/config/public` | 5min | 1h | no |
| `/feed/history` | 1min | 10min | yes |

**Optimistic update:** `POST /feed` — optimistic decrement balance, rollback kalau error. `POST /admin/devices/:id/stream/start` — optimistic `stream_status: 'starting'`.

---

## Styling & UX Standards

- **Mobile first:** semua user app design 375px–430px. Test di iPhone SE, Pixel 6, iPad mini.
- **Dark mode:** ikut system preference (Tailwind `dark:`).
- **Touch target:** min 44×44px (Apple HIG).
- **Loading:** Skeleton, bukan spinner. Spinner hanya untuk action button.
- **Empty state:** ilustrasi + CTA, jangan kosong.
- **Error:** toast + opsi retry. Untuk error 5xx → "Coba lagi" + log `request_id`.
- **a11y:** semua interactive ada `aria-label`, focus ring, kontras WCAG AA.
- **Offline:** detect `navigator.onLine` → banner "Tidak ada koneksi" + disable mutation buttons.
- **PWA:** install prompt + service worker (cache static asset + offline shell).

---

## Brand (D9 — placeholder)

```ts
// tailwind.config.ts
theme: {
  extend: {
    colors: {
      primary: { DEFAULT: '#FF7A59', /* placeholder orange */ ... },
      surface: { DEFAULT: '#FFF8F4', dark: '#1F1612' },
    },
    fontFamily: {
      sans: ['Inter Variable', 'sans-serif'],
    },
  }
}
```

User akan ganti setelah brand kit dari Purrtein.

---

## Testing Strategy (TDD — Mandatory)

CI block PR kalau test fail / coverage turun.

### Unit (Vitest + RTL)
- Komponen pure (StockIndicator, StatusBadge, FeedingHistoryItem) — snapshot + interaction.
- Hooks (useFeed, useBalance) — pakai MSW mock backend.
- Schema validators (zod) — share dengan backend.
- Coverage **70%** komponen.

### Integration (MSW)
- Halaman flow — render → mock GET → assert UI.
- Auth refresh flow — first 401 → retry sukses.
- WS event → UI update (mock socket.io-mock).

### E2E (Playwright)
- `/auth/register → topup → feed → wallet balance` happy path.
- Admin login → start stream → stop stream.
- Network offline → error states.
- Visual regression (Playwright + percy/argos).
- Coverage flows **100%** halaman utama.

### Contract Test
- Validate semua zod schema di `packages/schemas/` lawan `contracts/*.json` (share dari root). Update kalau backend bump versi.

### Accessibility
- `@axe-core/playwright` di e2e — fail kalau ada violation.

### Performance
- Lighthouse CI di PR — LCP < 2.5s, CLS < 0.1, TTI < 3.5s di slow 4G.

---

## Build & Deploy

- Next.js standalone output (`output: 'standalone'`).
- Image domains whitelist eksplisit.
- Deploy ke **Vercel** (user app) + **Cloudflare Pages** (admin) atau keduanya self-hosted via nginx reverse proxy ke Next standalone.
- Env via Vercel/CF env vars — secret tidak di repo.
- `NEXT_PUBLIC_*` saja yang exposed ke browser.

---

## Production-Disaster Checklist Spesifik Frontend

- ❗ **JWT di localStorage** → XSS dump session. **WAJIB cookie httpOnly** (sudah).
- ❗ **CORS wildcard di backend** → CSRF dari domain lain. Backend CORS whitelist eksplisit.
- ❗ **WHEP bandwidth bleed**: user buka stream lalu tutup tab tanpa cleanup → bandwidth jalan. Cleanup di `useEffect` return + `visibilitychange` listener.
- ❗ **WebSocket buffer overflow** kalau backend spam event saat user tab idle. `socket.io-client` buffer default ok, tapi jangan render setiap event — debounce update tabel admin 100ms.
- ❗ **Stale balance display**: setelah feed sukses, kalau invalidate gagal → user lihat saldo lama → ngeklik lagi → INSUFFICIENT_TOKENS. **Mitigasi:** tombol feed disabled setelah klik sampai `feeding.done`/`failed` arrived; manual refetch balance.
- ❗ **Race kondisi auth refresh** saat multi-tab → 2 tab paralel refresh, satu invalidate refresh token, satu lagi 401-loop. Pakai BroadcastChannel atau coordinate via cookie timestamp.
- ❗ **Map markers leak** kalau data update tanpa cleanup → memory leak React-Leaflet. Pakai `key` per marker + virtualize cluster.
- ❗ **Form double-submit**: tombol disabled setelah klik + idempotency key client-side untuk `POST /feed`.
- ❗ **CSP**: header strict (`script-src 'self' https://*.xendit.co; connect-src ...`). Tanpa CSP, third party script (analytics) bisa exfil session.
- ❗ **Hydration mismatch** kalau SSR pakai `Date.now()` → React warning + bug timezone. Format date hanya di client (`useEffect` set).
- ❗ **WebRTC iOS autoplay**: butuh `muted` + `playsInline`. Tanpa muted → blank video.
- ❗ **WHEP URL signed token expiry race**: refetch BEFORE expiry, bukan setelah. Restart PC dengan URL baru, tidak reconnect ke URL expired.
- ❗ **Leaflet bundle size**: tree-shake, lazy load peta page only (`dynamic(() => import('./Map'), { ssr: false })`).
- ❗ **Translate/typo di reason label** → user bingung. Wajib copy review oleh native speaker.
- ❗ **Xendit redirect callback URL mismatch** → user mendarat di blank page. Pastikan `success_redirect_url` whitelist di Xendit dashboard.

---

## Open Decisions (Frontend-side)

Lihat **`CLAUDE_integration_contract.md §15`** untuk daftar lengkap. Frontend-impacted:

| ID | Default sementara |
|---|---|
| D1 — login method | Email + password |
| D2 — peta/stream login? | Peta publik, stream wajib login |
| D3 — metode bayar | QRIS + VA + e-wallet (user-selectable) |
| D8 — stack | Next.js + RQ + Zustand + Axios (RESOLVED di doc ini) |
| D9 — brand | Placeholder orange + Inter sampai kit datang |

Item bisnis (F1–F8 di doc lama) dikonsolidasi ke D1–D9 di contract.
