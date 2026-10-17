# Deploy server hordes3d lên Cloudflare (Durable Objects)

Không cần thẻ tín dụng, không cần VPS. Free tier của Cloudflare gồm
100.000 Durable Object requests/ngày — đủ cho vài tiếng chơi mỗi ngày
ở bản MVP này.

## Cần chuẩn bị

- Tài khoản Cloudflare (bạn đã có)
- Node.js 18+ trên máy tính
- Code đã push lên GitHub: `thantaigocua1515-cmd/hordes3d`

## Các bước

### 1. Cài wrangler

```bash
npm install -g wrangler
```

### 2. Đăng nhập Cloudflare

```bash
wrangler login
```

Trình duyệt sẽ mở ra, bấm **Allow** cho Cloudflare Workers.

### 3. Lấy code về máy

```bash
git clone https://github.com/thantaigocua1515-cmd/hordes3d.git
cd hordes3d/cloudflare-worker
npm install
```

### 4. Deploy

```bash
npx wrangler deploy
```

Xong! Terminal sẽ in ra link, ví dụ:

```
https://hordes3d.<ten-tai-khoan-cua-ban>.workers.dev
```

### 5. Lấy link WebSocket cho game

Server game nằm ở đường dẫn `/ws`. Link đầy đủ:

```
wss://hordes3d.<ten-tai-khoan-cua-ban>.workers.dev/ws
```

### 6. Trỏ client (Vercel) về server này

Mở link client Vercel của bạn kèm tham số `?server=`:

```
https://<project-cua-ban>.vercel.app/?server=wss://hordes3d.<ten-tai-khoan-cua-ban>.workers.dev/ws
```

Game sẽ nhớ server này (lưu trong trình duyệt), chỉ cần làm một lần.
Hoặc nhập trực tiếp vào ô **Server** ở màn hình đăng nhập của game.

## Kiểm tra server còn sống không

Mở trên trình duyệt:

```
https://hordes3d.<ten-tai-khoan-cua-ban>.workers.dev/health
```

Thấy chữ `ok` là server đang chạy.

## Cập nhật code mới

```bash
git pull
npx wrangler deploy
```

## Lưu ý về free tier (nói thẳng)

- 100.000 requests/ngày ≈ **2–3 tiếng chơi mỗi ngày** (tick 10Hz).
  Hết quota thì game tạm dừng đến hôm sau — **không bị trừ tiền** (gói free
  không trừ tiền khi vượt quota).
- Muốn chơi nhiều hơn: nâng Workers Paid ($5/tháng → 1 triệu requests/tháng).
- Khi không có ai chơi, server tự "ngủ" (hibernate), tốn $0.
  World được lưu lại, có người vào là chơi tiếp.

## Gỡ lỗi nhanh

- `wrangler deploy` báo lỗi account: chạy lại `wrangler login`.
- Client báo "cannot connect": kiểm tra lại link `wss://.../ws`
  (đúng 2 chữ s, đúng đường dẫn `/ws`), và mở `/health` xem server có sống không.
- Xem log realtime: `npx wrangler tail`
