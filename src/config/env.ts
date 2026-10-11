
import "dotenv/config";

export const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  PORT: Number(process.env.PORT ?? 3000),
  HOST: process.env.HOST ?? "0.0.0.0",
  NODE_ENV: process.env.NODE_ENV ?? "development",

  MIKROTIK_HOST: process.env.MIKROTIK_HOST ?? "",
  MIKROTIK_PORT: Number(process.env.MIKROTIK_PORT ?? 8728),
  MIKROTIK_USERNAME: process.env.MIKROTIK_USERNAME ?? "",
  MIKROTIK_PASSWORD: process.env.MIKROTIK_PASSWORD ?? "",

  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? "",
  SESSION_SECRET: process.env.SESSION_SECRET ?? ""
};

if (!env.DATABASE_URL) {
  throw new Error("DATABASE_URL belum di-set. Salin .env.example menjadi .env");
}

if (
  !env.MIKROTIK_HOST ||
  !env.MIKROTIK_USERNAME ||
  !env.MIKROTIK_PASSWORD
) {
  throw new Error("Konfigurasi MikroTik belum lengkap di .env");
}

if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 12) {
  throw new Error("ADMIN_PASSWORD wajib diisi dan minimal 12 karakter.");
}

if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET wajib diisi dan minimal 32 karakter.");
}