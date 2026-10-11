# WiFi Voucher Backend — MVP

Backend awal untuk project penjualan voucher WiFi otomatis.

## Stack

- Node.js
- TypeScript
- Fastify
- Prisma
- PostgreSQL
- Docker Compose

## 1. Prasyarat

Install:

- Node.js 20+
- Docker Desktop

Cek:

```bash
node -v
npm -v
docker -v
```

## 2. Install dependency

```bash
npm install
```

## 3. Jalankan PostgreSQL

```bash
docker compose up -d
```

## 4. Buat file environment

Linux/macOS:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

## 5. Buat database schema

```bash
npm run db:migrate -- --name init
```

## 6. Generate Prisma Client

```bash
npm run db:generate
```

## 7. Isi paket awal

```bash
npm run db:seed
```

Paket yang dibuat:

- 12J — 12 jam — 25 Mbps — Rp3.000
- 1H — 1 hari — 10 Mbps — Rp5.000
- 3H — 3 hari — 10 Mbps — Rp10.000
- 7H — 7 hari — 15 Mbps — Rp15.000
- 14H — 14 hari — 15 Mbps — Rp25.000
- 30H — 30 hari — 25 Mbps — Rp50.000

## 8. Jalankan backend

```bash
npm run dev
```

Backend:

http://localhost:3000

Health check:

```text
GET /health
```

## 9. Test API

### Lihat paket

```bash
curl http://localhost:3000/api/packages
```

### Generate 10 voucher 12J

```bash
curl -X POST http://localhost:3000/api/admin/vouchers/generate \
  -H "Content-Type: application/json" \
  -d "{\"packageCode\":\"12J\",\"quantity\":10}"
```

### Lihat voucher

```bash
curl http://localhost:3000/api/admin/vouchers
```

### Buat order demo

```bash
curl -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -d "{\"packageCode\":\"12J\",\"customerIdentifier\":\"TEST-001\"}"
```

Response akan memberikan `orderId`.

### Cek order

```bash
curl http://localhost:3000/api/orders/ORDER_ID
```

## 10. Prisma Studio

Untuk melihat database secara visual:

```bash
npm run db:studio
```

Buka:

http://localhost:5555

## Catatan keamanan

Endpoint `/api/admin/*` BELUM diamankan pada MVP ini.

Jangan expose endpoint admin ke internet sebelum authentication, authorization, rate limit, dan secret management ditambahkan.

Pembayaran juga masih `DEMO/MANUAL`. Jangan anggap order sebagai pembayaran valid.

Tahap berikutnya:
1. repository/service layer
2. authentication admin
3. payment gateway + QRIS
4. webhook verification
5. MikroTik API
6. deployment VPS
