
import "dotenv/config";

const mikrotikMode = process.env.MIKROTIK_MODE ?? "real";

if (mikrotikMode !== "real" && mikrotikMode !== "simulator") {
  throw new Error(
    'MIKROTIK_MODE harus bernilai "real" atau "simulator".'
  );
}

export const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  PORT: Number(process.env.PORT ?? 3000),
  HOST: process.env.HOST ?? "0.0.0.0",
  NODE_ENV: process.env.NODE_ENV ?? "development",

  MIKROTIK_MODE: mikrotikMode as "real" | "simulator",
  MIKROTIK_HOST: process.env.MIKROTIK_HOST ?? "",
  MIKROTIK_PORT: Number(process.env.MIKROTIK_PORT ?? 8728),
  MIKROTIK_USERNAME: process.env.MIKROTIK_USERNAME ?? "",
  MIKROTIK_PASSWORD: process.env.MIKROTIK_PASSWORD ?? "",

    DUITKU_MODE: process.env.DUITKU_MODE ?? "sandbox",
  DUITKU_MERCHANT_CODE: process.env.DUITKU_MERCHANT_CODE ?? "",
  DUITKU_API_KEY: process.env.DUITKU_API_KEY ?? "",
  DUITKU_BASE_URL:
    process.env.DUITKU_BASE_URL ??
    "https://api-sandbox.duitku.com/api/merchant/createInvoice",
  DUITKU_CALLBACK_URL: process.env.DUITKU_CALLBACK_URL ?? "",
  DUITKU_RETURN_URL: process.env.DUITKU_RETURN_URL ?? "",

  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? "",
  SESSION_SECRET: process.env.SESSION_SECRET ?? "",
};

if (!env.DATABASE_URL) {
  throw new Error("DATABASE_URL belum di-set.");
}

if (env.MIKROTIK_MODE === "real") {
  if (
    !env.MIKROTIK_HOST ||
    !env.MIKROTIK_USERNAME ||
    !env.MIKROTIK_PASSWORD
  ) {
    throw new Error(
      "Konfigurasi MikroTik belum lengkap."
    );
  }
}

if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 12) {
  throw new Error(
    "ADMIN_PASSWORD wajib diisi dan minimal 12 karakter."
  );
}

if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
  throw new Error(
    "SESSION_SECRET wajib diisi dan minimal 32 karakter."
  );
}
