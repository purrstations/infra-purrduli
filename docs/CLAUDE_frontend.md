# CLAUDE.md — Frontend (Purrtein Smart Cat Feeder)

> Dokumen ini adalah konteks utama untuk agent AI yang mengerjakan implementasi frontend. Baca seluruhnya sebelum mulai coding.
>
> **WAJIB BACA DULU:** `CLAUDE_integration_contract.md` — semua schema payload, error code, WebSocket event, dan konstanta ditentukan di sana. Dokumen ini hanya implementasi sisi frontend.

---

## Project Context

Dua aplikasi:

1. **User App** — Mobile-first SPA untuk publik (donasi, feed, livestream, peta).
2. **Admin Dashboard** — Desktop web untuk admin internal (monitoring device, kontrol stream, pairing device baru, notif).

Keduanya consume REST + WebSocket dari backend Purrtein.

---

## Tech Stack (Final — D8 resolved)

| Hal | Pilihan |
|---|---|
| Build tool | **Vite 5** |
| Framework | **React 18** (SPA, no SSR) |
| Bahasa | TypeScript (strict mode) |
| Router | **React Router 6** (data routers — `createBrowserRouter`) |
| Styling | Tailwind CSS + `clsx` + `tailwind-merge` |
| UI primitives | shadcn/ui (Radix-based) |
| Server state | **TanStack Query (React Query) v5** — single source untuk semua data dari backend |
| Client state | **`useState` + Context** untuk UI lokal (modal open, sidebar collapsed). Tidak pakai Zustand/Redux — TanStack Query + Context sudah cukup |
| HTTP client | **Axios** dengan interceptor refresh |
| WebSocket | **socket.io-client** v4, di-mount via Context, event di-pipe ke `queryClient.setQueryData` |
| Form | `react-hook-form` + `zod` (schema sama dengan backend) |
| Peta | `react-leaflet` v4 |
| WebRTC Player | Native `RTCPeerConnection` via WHEP (no library) |
| Payment | Xendit hosted invoice (redirect) |
| Auth storage | httpOnly cookie (set oleh backend) — frontend TIDAK akses JWT |
| Date/Time | `date-fns` + `date-fns-tz` (display UTC → WIB) |
| Toast | `sonner` |
| Testing | **Vitest + React Testing Library + MSW + Playwright** |
| Error reporting | Sentry |

> **Note:** SSR / SEO untuk landing/peta = tidak ada. Mitigasi: meta tags via `react-helmet-async` + prerender HTML statis (`vite-plugin-prerender` opsional) untuk route `/` saja. Phase 1: SPA murni cukup.

> **Note:** Zustand di-drop. TanStack Query menyimpan server state global; client state minor (modal, drawer) cukup lokal. Auth state = derive dari hasil `useQuery(['auth-me'])`. Kalau di kemudian hari ada kebutuhan global UI state yang complicated (mis. theme builder), pertimbangkan ulang.

---

## Struktur Monorepo

```
frontend/
├── apps/
│   ├── user/                 # Vite — user app
│   │   ├── src/
│   │   │   ├── main.tsx
│   │   │   ├── App.tsx
│   │   │   ├── routes/       # route components (loader-aware)
│   │   │   ├── pages/        # page components
│   │   │   ├── components/
│   │   │   └── lib/
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── tsconfig.json
│   └── admin/                # Vite — admin dashboard
├── packages/
│   ├── ui/                   # shared shadcn components
│   ├── api-client/           # axios + react-query hooks + zod schemas
│   ├── schemas/              # zod (mirror backend + contract)
│   ├── ws-client/            # socket.io wrapper + typed events
│   └── stream-player/        # <StreamPlayer> WHEP component
├── contracts/                # JSON payload examples (mirror dari root /contracts)
├── package.json              # workspace root
├── pnpm-workspace.yaml       # pakai pnpm workspaces (atau turborepo kalau perlu cache)
└── turbo.json                # opsional
```

Tooling: **pnpm** + workspaces. Tambah Turborepo kalau build time > 60 detik.

---

## Routing (React Router 6 data routers)

### User App (`apps/user`)

```
/                    → Landing + peta semua feeder aktif (public)
/feeder/:id          → Detail feeder + livestream
/feeder/:id/feed     → Konfirmasi feeding (wajib login)
/topup               → Pilih paket + metode bayar (wajib login)
/topup/pending       → Polling/WS wait pembayaran
/wallet              → Saldo + riwayat (wajib login)
/history             → Riwayat feeding (wajib login)
/auth/login          → Login
/auth/register       → Register
/auth/forgot         → Forgot password (Phase 1 manual)
/legal/tos
/legal/privacy
```

```tsx
// apps/user/src/routes/index.tsx
const router = createBrowserRouter([
  { path: '/', element: <HomePage/> },
  { path: '/feeder/:id', element: <FeederDetailPage/> },
  {
    element: <ProtectedLayout/>,        // cek auth via loader
    children: [
      { path: '/feeder/:id/feed', element: <FeedConfirmPage/> },
      { path: '/topup', element: <TopupPage/> },
      { path: '/topup/pending', element: <TopupPendingPage/> },
      { path: '/wallet', element: <WalletPage/> },
      { path: '/history', element: <HistoryPage/> },
    ],
  },
  { path: '/auth/login', element: <LoginPage/> },
  { path: '/auth/register', element: <RegisterPage/> },
]);
```

### Admin Dashboard (`apps/admin`)

```
/login                  → Admin login
/                       → Dashboard summary
/devices                → Tabel device
/devices/new            → Wizard tambah device (BLE pairing + QR)
/devices/:id            → Detail + log + stream control + refill
/devices/:id/pair       → Pairing-status poll
/notifications          → Riwayat alert
/users                  → List user (super_admin)
/admins                 → Manage admin (super_admin)
/audit                  → Audit log (super_admin)
/settings               → Constants viewer (`/config/public`)
```

### Auth Guard (loader-based)

```tsx
// apps/user/src/routes/ProtectedLayout.tsx
export async function authLoader() {
  try {
    await queryClient.ensureQueryData({ queryKey: ['auth-me'], queryFn: fetchMe });
    return null;
  } catch {
    return redirect(`/auth/login?from=${encodeURIComponent(location.pathname)}`);
  }
}

export function ProtectedLayout() {
  return <Outlet/>;
}
```

---

## API Client

```env
VITE_API_BASE_URL=https://api.purrtein.com/api/v1
VITE_WS_URL=https://api.purrtein.com
VITE_SENTRY_DSN=...
```

`packages/api-client/src/http.ts`:

```ts
export const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  withCredentials: true,   // kirim cookie httpOnly
  timeout: 10_000,
});

http.interceptors.request.use((cfg) => {
  cfg.headers['X-Request-ID'] = crypto.randomUUID();
  return cfg;
});

let isRefreshing = false;
let pendingQueue: Array<(e?: Error) => void> = [];

http.interceptors.response.use(null, async (err: AxiosError) => {
  const original = err.config as InternalAxiosRequestConfig & { _retry?: boolean };
  if (err.response?.status === 401 && !original._retry) {
    if (isRefreshing) {
      await new Promise<void>((res, rej) => pendingQueue.push((e) => (e ? rej(e) : res())));
      return http(original);
    }
    original._retry = true;
    isRefreshing = true;
    try {
      await http.post('/auth/refresh');
      pendingQueue.forEach((cb) => cb());
      pendingQueue = [];
      return http(original);
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

---

## TanStack Query Strategy

Semua data dari backend = TanStack Query. **Tidak ada manual state copy ke Context/Zustand.**

```ts
// packages/api-client/src/queries/auth.ts
export function useMe() {
  return useQuery({
    queryKey: ['auth-me'],
    queryFn: () => http.get('/auth/me').then(r => r.data),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

// packages/api-client/src/queries/feed.ts
export function useFeedMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FeedRequest) => http.post('/feed', body).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['token-balance'] });
      qc.invalidateQueries({ queryKey: ['feed-history'] });
    },
  });
}
```

### Cache config standard

| Resource | staleTime | gcTime | refetchOnWindowFocus |
|---|---|---|---|
| `auth-me` | 5min | 30min | true |
| `devices` (peta) | 30s | 5min | true |
| `device/:id` | 30s | 5min | true |
| `token-balance` | 5s | 5min | **false** kalau WS connected (rely on event), true kalau tidak |
| `token-packages` | 5min | 30min | false |
| `config-public` | 5min | 1h | false |
| `feed-history` | 1min | 10min | true |

### Query key convention

```ts
['devices']
['device', deviceId]
['device', deviceId, 'stream']
['device', deviceId, 'logs', { page, status }]
['token-balance']
['token-packages']
['feed-history', { page }]
```

### Optimistic update

`POST /feed`:
```ts
useMutation({
  mutationFn: feed,
  onMutate: async (body) => {
    await qc.cancelQueries({ queryKey: ['token-balance'] });
    const prev = qc.getQueryData<{balance: number}>(['token-balance']);
    qc.setQueryData(['token-balance'], (old: any) => ({ balance: (old?.balance ?? 0) - body.rotations }));
    return { prev };
  },
  onError: (_e, _v, ctx) => {
    if (ctx?.prev) qc.setQueryData(['token-balance'], ctx.prev);
  },
  onSettled: () => qc.invalidateQueries({ queryKey: ['token-balance'] }),
});
```

---

## WebSocket — Integrasi ke TanStack Query

`packages/ws-client/`:

```ts
const socket = io(import.meta.env.VITE_WS_URL, {
  withCredentials: true,
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

type Events = {
  // core
  'device.status': { device_id: string; status: string; stock_level: number; total_rotations: number; updated_at: string };
  'device.alert':  { device_id: string; type: string; message: string };
  'device.stream': { device_id: string; state: string; session_id?: string; whep_url?: string };
  'feeding.queued': { feeding_log_id: string; device_id: string; origin: 'user'|'gift' };
  'feeding.done':  { feeding_log_id: string; device_id: string; status: string; rotations: number; origin: 'user'|'gift' };
  'feeding.failed': { feeding_log_id: string; device_id: string; reason: string; token_refunded: boolean; origin: 'user'|'gift' };
  'token.credited': { balance: number; topup_id: string };
  'token.debited':  { balance: number; reason: string };
  'topup.failed':   { external_id: string; reason: string };

  // sosial layer (room stream:{session_id})
  'stream.session': { session_id: string; started_at: string; viewer_count: number; you: { tier: string; preview_remaining_s?: number }};
  'viewer.joined': { session_id: string; count: number; user?: { id: string; handle: string; avatar?: string }};
  'viewer.left':   { session_id: string; count: number };
  'chat.message':  { id: string; user: { id: string; handle: string; avatar?: string; badge?: string }; content: string; type: 'text'|'sticker'|'system'; sticker?: any; created_at: string };
  'chat.deleted':  { message_id: string; deleted_by_role: string };
  'sticker.sent':  { id: string; user: any; sticker: { code: string; image_url: string; animation_ms: number }; tier: string };
  'gift.sent':     { id: string; user: any; gift: { code: string; name: string; image_url: string; animation_url: string; tier: string; feed_rotations: number }; status: string };
  'gift.feed_done':{ gift_id: string; feeding_log_id: string; status: string; reason?: string };
  'preview.expiring': { remaining_s: number };
  'preview.expired': {};
  'system.notice': { severity: string; message: string };
  'moderation.muted': { until: string; reason: string };
  'moderation.banned': { reason: string };
};
```

```tsx
// apps/user/src/lib/WSProvider.tsx
export function WSProvider({ children }: PropsWithChildren) {
  const qc = useQueryClient();
  useEffect(() => {
    socket.connect();

    socket.on('token.credited', (p) => {
      qc.setQueryData(['token-balance'], { balance: p.balance });
      toast.success('Topup berhasil!');
    });

    socket.on('feeding.done', (p) => {
      qc.invalidateQueries({ queryKey: ['feed-history'] });
      qc.invalidateQueries({ queryKey: ['token-balance'] });
    });

    socket.on('feeding.failed', (p) => {
      qc.invalidateQueries({ queryKey: ['token-balance'] }); // refund
      toast.error(REASON_LABEL[p.reason] ?? 'Gagal memberi makan.');
    });

    socket.on('device.status', (p) => {
      qc.setQueryData(['device', p.device_id], (old: any) => ({ ...old, ...p }));
    });

    socket.io.on('reconnect', () => {
      // Server tidak replay event yang missed — sync ulang.
      qc.invalidateQueries({ queryKey: ['devices'] });
      qc.invalidateQueries({ queryKey: ['token-balance'] });
    });

    return () => { socket.disconnect(); socket.off(); };
  }, [qc]);

  return <>{children}</>;
}
```

**Idempotency event:** event bisa double. Untuk update yang derived dari status final (`feeding.done`), cek `feeding_log_id` di local cache — jika sudah final, skip.

### WS untuk sosial layer (per stream session)

Saat user buka `/feeder/:id` dan stream aktif → `socket.emit('stream.join', { device_id })` → server reply `stream.session` dengan `session_id` + status user (anon preview remaining_s, atau login full). Setelah itu pasang handler chat/sticker/gift/viewer/preview ke `queryClient` (chat history) + local state (animasi ephemeral).

```tsx
// useStreamSocial.ts
export function useStreamSocial(deviceId: string) {
  const qc = useQueryClient();
  const [session, setSession] = useState<SessionMeta|null>(null);
  const [previewRemaining, setPreviewRemaining] = useState<number|null>(null);
  const [animations, setAnimations] = useState<Animation[]>([]);

  useEffect(() => {
    socket.emit('stream.join', { device_id: deviceId });

    socket.on('stream.session', (m) => { setSession(m); setPreviewRemaining(m.you.preview_remaining_s ?? null); });
    socket.on('chat.message', (m) => qc.setQueryData(['chat', m.session_id], (old: any[] = []) => [...old.slice(-49), m]));
    socket.on('chat.deleted', ({ message_id }) => qc.setQueryData(['chat'], (old: any[] = []) => old.filter(c => c.id !== message_id)));
    socket.on('sticker.sent', (s) => setAnimations(a => [...a, { type: 'sticker', ...s, expires_at: Date.now() + s.sticker.animation_ms }]));
    socket.on('gift.sent', (g) => setAnimations(a => [...a, { type: 'gift', ...g, expires_at: Date.now() + g.gift.display_duration_ms }]));
    socket.on('viewer.joined', ({ count }) => qc.setQueryData(['viewer-count', session?.session_id], count));
    socket.on('viewer.left',   ({ count }) => qc.setQueryData(['viewer-count', session?.session_id], count));
    socket.on('preview.expiring', ({ remaining_s }) => setPreviewRemaining(remaining_s));
    socket.on('preview.expired', () => { setPreviewRemaining(0); /* router push login */ });
    socket.on('system.notice', (n) => toast(n.message, { type: n.severity }));
    socket.on('moderation.muted', (m) => toast.error(`Kamu di-mute sampai ${m.until}: ${m.reason}`));

    return () => {
      socket.emit('stream.leave', { session_id: session?.session_id });
      socket.off('stream.session'); socket.off('chat.message'); /* ...semua off */
    };
  }, [deviceId, qc]);

  // GC animasi yang sudah expired
  useEffect(() => {
    const t = setInterval(() => setAnimations(a => a.filter(x => x.expires_at > Date.now())), 500);
    return () => clearInterval(t);
  }, []);

  return { session, previewRemaining, animations };
}
```

**Mutations sosial:**

```ts
useChatSend()    // POST via socket.emit('chat.send', ...) atau REST fallback
useStickerSend() // emit('sticker.send', ...)
useGiftSend()    // POST /streams/:id/gifts { gift_code, idempotency_key: uuid() }
```

Idempotency gift WAJIB pakai client-generated UUID. Tap berulang → satu transaksi.

---

## Halaman & Komponen Inti

### 1. Home — Peta Feeder

- `react-leaflet` + OpenStreetMap tiles.
- Lazy-load (`React.lazy`) supaya bundle peta tidak masuk halaman lain.
- Marker: hijau (online), abu (offline), kuning (stock_low).
- Click marker → bottom sheet preview → CTA "Detail".
- Cluster marker (>50 device) via `react-leaflet-cluster`.

### 2. Detail Feeder (livestream + sosial)

Data: `useDevice(id)` + `useStream(id)` + `useStreamSocial(id)`.

Halaman ini adalah **hub sosial**, bukan static detail. Layout vertical TikTok-style untuk mobile (lihat spec lengkap di `CLAUDE_uiux.md §12.2`). Frontend tanggung jawab:

- `<StreamPlayer deviceId>` — WHEP video (lihat section di bawah).
- `<ChatOverlay session>` — list chat real-time, virtualized.
- `<ChatInput>` — input + sticker picker + gift drawer trigger. Disabled untuk anon (tampil "🔒 Login untuk chat").
- `<StickerAnimation>` — overlay float ephemeral, dari `animations` state.
- `<GiftAnimation>` — overlay takeover sesuai tier.
- `<ViewerCount>` + `<ViewerAvatarStack>` di header overlay.
- `<PreviewCountdown remaining_s>` — sticky banner saat user anon, countdown 60 → 0 → trigger login modal.
- `<PreviewExpiredModal>` — full block setelah expired, CTA login.
- CTA "Beri Makan" tetap ada (icon 🥣 di input bar mobile, button kanan desktop) — disabled saat offline/saldo 0/cooldown.

Component-component di atas semua di `packages/ui` + Storybook + axe-tested.

### 3. Konfirmasi Feeding (`/feeder/:id/feed`)

Flow:
1. `useBalance()` (cached 5s).
2. `useConfigPublic()` → ambil `ROTATIONS_PER_TOKEN`, `MAX_ROTATIONS_PER_REQUEST`.
3. UI: stepper `rotations: 1..MAX` → tampil "estimasi pakan: ~X gram" + "biaya: N token".
4. Saldo < N → tombol "Topup".
5. Konfirmasi → `useFeedMutation().mutate({device_id, rotations: N, idempotency_key: uuid()})`.
   - 202 → set local state "queued", subscribe WS event.
6. WS `feeding.done` `status='completed'` → success screen.
7. WS `feeding.failed` → toast reason yang user-friendly. Token auto-refunded.

**Anti-double-submit:** disable tombol setelah klik; idempotency key client-side di body (24 jam window di Redis backend).

**Catatan:** feed boleh saat stream berjalan — UI BOLEH tampilkan badge "Sedang ditonton X orang" tapi jangan disable tombol feed (lihat contract §5).

### 4. Topup (`/topup`)

1. `useQuery(['token-packages'])` → render card list.
2. Pilih paket → pilih metode (QRIS + VA BCA + e-wallet).
3. `useMutation` POST topup → `payment_url`.
4. `window.location.href = payment_url`.

### 5. Pending (`/topup/pending`)

- Read `?ext=` param dari Xendit redirect back.
- Subscribe WS `token.credited`, `topup.failed`.
- Fallback poll `useQuery(['topup', ext], { refetchInterval: 5000 })`.
- Timeout 5 menit → "Cek riwayat di /wallet".

### 6. Wallet

- `useBalance()` (live via WS).
- `useInfiniteQuery(['tokens-history'])` — infinite scroll.

### 7. Admin Dashboard

- Tabel device — server-side paginated. Sort by `last_seen`.
- Real-time update via WS `device.status`, `device.alert`.
- Indikator notifikasi baru di top bar (badge count).

### 8. Detail Device Admin

- Status, log, kontrol.
- **Start/Stop Stream** — toggle. State: `inactive → starting → active → stopped`.
- Stream player preview saat `active`.
- **Refill** button: confirm → POST → WS update.
- **Reset secret**: confirm 2x → new secret + QR (sekali).
- Stock alert badge.

### 9. Add Device Wizard (`/devices/new`)

Flow BLE pairing (lihat contract §8):
1. Form: name, location_label, lat/lng (map picker).
2. Backend create → `{device_id, device_secret}`. QR code berisi JSON config. Warning "secret hanya muncul sekali".
3. Instruksi teknisi — "Power on device, scan QR via mobile app".
4. Poll `useQuery(['device', id, 'pairing-status'], { refetchInterval: 3000 })` sampai `online` (timeout 15min).

---

## WebRTC Livestream (WHEP)

`packages/stream-player/StreamPlayer.tsx`:

```tsx
export function StreamPlayer({ deviceId }: { deviceId: string }) {
  const { data } = useQuery({
    queryKey: ['device', deviceId, 'stream'],
    queryFn: () => http.get(`/devices/${deviceId}/stream`).then(r => r.data),
    refetchInterval: (q) => {
      const exp = q.state.data?.expires_at;
      if (!exp) return false;
      const msLeft = new Date(exp).getTime() - Date.now();
      return Math.max(5_000, msLeft - 10_000);   // refresh 10s sebelum expiry
    },
  });

  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

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
    })().catch((e) => Sentry.captureException(e));

    return () => { pc.close(); pcRef.current = null; };
  }, [data?.whep_url]);

  // Hemat bandwidth: pause saat tab tidak aktif
  useEffect(() => {
    const onVis = () => {
      if (document.hidden && pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  if (!data) return <Skeleton/>;
  if (data.status !== 'active') return <StreamPlaceholder status={data.status}/>;
  return <video ref={videoRef} autoPlay playsInline muted className="w-full rounded-lg"/>;
}
```

**Penting:**
- `playsInline muted` — iOS Safari autoplay butuh muted.
- Cleanup `pc.close()` saat unmount + `visibilitychange`.
- Periodic refetch URL sebelum `expires_at` (signed token TTL 60s).

---

## Vite Config

```ts
// apps/user/vite.config.ts
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  server: { port: 5173, proxy: {
    '/api': 'http://localhost:4000',
    '/socket.io': { target: 'ws://localhost:4000', ws: true },
  }},
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'leaflet': ['leaflet', 'react-leaflet'],
        },
      },
    },
  },
});
```

---

## Auth Flow

1. `POST /auth/login` → backend set 2 httpOnly cookie (`access`, `refresh`).
2. `useMe()` → hydrate auth dari `/auth/me`.
3. Axios interceptor 401 → silent refresh → retry.
4. Logout: `POST /auth/logout` → server hapus cookie + invalidate → `queryClient.clear()` + redirect.

---

## Error Mapping

```ts
const REASON_LABEL: Record<string, string> = {
  motor_stall: 'Motor gagal. Token dikembalikan, admin sudah diberitahu.',
  insufficient_stock: 'Stok pakan habis. Token dikembalikan.',
  busy_feeding: 'Feeder sedang memberi makan kucing lain. Coba 30 detik lagi.',
  command_expired: 'Permintaan kadaluwarsa. Coba ulang.',
  invalid_payload: 'Permintaan tidak valid. Hubungi support.',
  time_not_synced: 'Feeder belum siap. Coba 1 menit lagi.',
  device_offline: 'Feeder offline.',
};
```

> **Catatan:** `busy_streaming` SUDAH DIHAPUS (lihat contract §4.3/§5). UI tidak perlu kasih warning "lagi streaming" saat user mau feed.

---

## Styling & UX Standards

- **Mobile first:** semua user app design 375px–430px. Test iPhone SE, Pixel 6.
- **Dark mode:** Tailwind `dark:` ikut system.
- **Touch target:** min 44×44px.
- **Loading:** Skeleton, bukan spinner. Spinner hanya untuk action button.
- **Empty state:** ilustrasi + CTA.
- **Error:** toast + retry. 5xx tampilkan `request_id`.
- **a11y:** semua interactive ada `aria-label`, focus ring, WCAG AA.
- **Offline:** detect `navigator.onLine` → banner + disable mutation buttons.
- **PWA:** install prompt + service worker (cache static asset + offline shell) via `vite-plugin-pwa`.

---

## Brand (D9 — placeholder)

```ts
// tailwind.config.ts
theme: {
  extend: {
    colors: {
      primary: { DEFAULT: '#FF7A59' /* placeholder orange */ },
      surface: { DEFAULT: '#FFF8F4', dark: '#1F1612' },
    },
    fontFamily: { sans: ['Inter Variable', 'sans-serif'] },
  }
}
```

---

## Testing Strategy (TDD — Mandatory)

CI block PR kalau test fail / coverage turun.

### Unit (Vitest + RTL)
- Komponen pure (StockIndicator, StatusBadge) — snapshot + interaction.
- Hooks (`useFeedMutation`, `useBalance`) — pakai MSW mock backend.
- Schema validators (zod) — share dengan backend.
- Coverage **70%** komponen.

### Integration (MSW)
- Halaman flow — render → mock GET → assert UI.
- Auth refresh: first 401 → retry sukses.
- WS event → query cache update (mock socket).

### E2E (Playwright)
- `register → topup → feed → wallet balance` happy path.
- Admin login → start stream → stop stream.
- Network offline → error states.
- Visual regression (Playwright snapshots).
- Coverage **100%** halaman utama.

### Contract Test
- Validasi semua zod schema di `packages/schemas/` lawan `contracts/*.json`.

### Accessibility
- `@axe-core/playwright` di e2e — fail kalau ada violation.

### Performance
- Lighthouse CI di PR — LCP < 2.5s, CLS < 0.1, TTI < 3.5s (slow 4G).

---

## Build & Deploy

- `vite build` → static `dist/`.
- Serve via nginx (sudah ada di `infra-purrduli`):
  ```nginx
  location / {
    root /var/www/user-app;
    try_files $uri $uri/ /index.html;
  }
  ```
- Env via build-time `import.meta.env.VITE_*` (compiled in).
- 2 build: `apps/user` → `app.purrtein.com`, `apps/admin` → `admin.purrtein.com`. Beda subdomain supaya cookie scope rapi (set domain ke `.purrtein.com` di backend).

---

## Production-Disaster Checklist Spesifik Frontend

- ❗ **JWT di localStorage** → XSS dump session. **WAJIB httpOnly cookie** (sudah).
- ❗ **CORS wildcard** → CSRF dari domain lain. Backend whitelist eksplisit.
- ❗ **WHEP bandwidth bleed** kalau user tutup tab tanpa cleanup. Cleanup di `useEffect return` + `visibilitychange`.
- ❗ **WebSocket buffer overflow** saat backend spam event. Debounce update tabel admin 100ms.
- ❗ **Stale balance display** setelah refund: WS `feeding.failed` → invalidate `token-balance`. Kalau WS putus → user lihat saldo lama → invalidate juga di reconnect.
- ❗ **Race auth refresh multi-tab**: 2 tab paralel call `/auth/refresh` → satu invalidate refresh token, satu lagi 401-loop. Solusi: serialize via `BroadcastChannel` atau pasrah lock via `navigator.locks.request('auth-refresh', ...)`.
- ❗ **Map markers leak** kalau data update tanpa cleanup → memory leak. Pakai `key` per marker + virtualize cluster.
- ❗ **Form double-submit**: tombol disabled + idempotency key di body.
- ❗ **CSP**: header strict (`script-src 'self' https://*.xendit.co; connect-src ...`). Set di nginx response header.
- ❗ **WebRTC iOS autoplay**: butuh `muted` + `playsInline`. Tanpa muted → blank video.
- ❗ **WHEP signed token expiry race**: refetch BEFORE expiry, bukan sesudah. Restart PC dengan URL baru.
- ❗ **Leaflet bundle size**: lazy load (`React.lazy(() => import('./MapPage'))`) supaya halaman lain ramping.
- ❗ **Translate/typo reason label** → user bingung. Native speaker review wajib.
- ❗ **Xendit redirect URL mismatch** → blank page. Whitelist `success_redirect_url` di Xendit dashboard.
- ❗ **React Query stale closure di socket handler**: handler effect harus depend `[qc]`, jangan capture state langsung.
- ❗ **SPA refresh hard route**: nginx wajib fallback `/index.html` untuk semua route (lihat config di atas) — kalau tidak, refresh di `/wallet` = 404.
- ❗ **Vite env leak**: `VITE_*` ke-bundle ke JS publik. Jangan taruh secret di env build-time (mis. Xendit secret, FCM admin key).

---

## Open Decisions (Frontend-side)

Lihat **`CLAUDE_integration_contract.md §15`** untuk daftar lengkap.

| ID | Default sementara |
|---|---|
| D1 — login method | Email + password |
| D2 — peta/stream login? | Peta publik, stream wajib login |
| D3 — metode bayar | QRIS + VA + e-wallet (user-selectable) |
| D8 — stack | **React 18 + Vite 5 + React Router 6 + TanStack Query v5 + Axios** (RESOLVED) |
| D9 — brand | Placeholder orange + Inter sampai kit datang |
