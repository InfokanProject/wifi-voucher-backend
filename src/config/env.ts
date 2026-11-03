
import "dotenv/config";

const mikrotikMode = process.env.MIKROTIK_MODE ?? "real";
const midtransProductionRaw =
  process.env.MIDTRANS_IS_PRODUCTION ?? "false";

if (mikrotikMode !== "real" && mikrotikMode !== "simulator") {
  throw new Error(
    'MIKROTIK_MODE harus bernilai "real" atau "simulator".'
  );
}

if (
  midtransProductionRaw !== "true" &&
  midtransProductionRaw !== "false"
) {
  throw new Error(
    'MIDTRANS_IS_PRODUCTION harus bernilai "true" atau "false".'
  );
}

export const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  PORT: Number(process.env.PORT ?? 3000),
  HOST: process.env.HOST ?? "0.0.0.0",
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PUBLIC_APP_URL: (process.env.PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, ""),

  MIKROTIK_MODE: mikrotikMode as "real" | "simulator",
  MIKROTIK_HOST: process.env.MIKROTIK_HOST ?? "",
  MIKROTIK_PORT: Number(process.env.MIKROTIK_PORT ?? 8728),
  MIKROTIK_USERNAME: process.env.MIKROTIK_USERNAME ?? "",
  MIKROTIK_PASSWORD: process.env.MIKROTIK_PASSWORD ?? "",

  MIDTRANS_IS_PRODUCTION: midtransProductionRaw === "true",
  MIDTRANS_SERVER_KEY: process.env.MIDTRANS_SERVER_KEY ?? "",
  MIDTRANS_CLIENT_KEY: process.env.MIDTRANS_CLIENT_KEY ?? "",

  WAROENGPAY_API_KEY: process.env.WAROENGPAY_API_KEY ?? "",
  WAROENGPAY_WEBHOOK_SECRET: process.env.WAROENGPAY_WEBHOOK_SECRET ?? "",
  ACTIVE_PAYMENT_GATEWAY:
    (process.env.ACTIVE_PAYMENT_GATEWAY ?? "midtrans").trim().toLowerCase() === "waroengpay"
      ? ("waroengpay" as const)
      : ("midtrans" as const),

  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? "",
  SESSION_SECRET: process.env.SESSION_SECRET ?? "",
};

if (!env.DATABASE_URL) {
  throw new Error("DATABASE_URL belum di-set.");
}

if (!env.MIDTRANS_SERVER_KEY || !env.MIDTRANS_CLIENT_KEY) {
  throw new Error(
    "Konfigurasi MIDTRANS_SERVER_KEY dan MIDTRANS_CLIENT_KEY belum lengkap."
  );
}

if (env.MIKROTIK_MODE === "real") {
  if (
    !env.MIKROTIK_HOST ||
    !env.MIKROTIK_USERNAME ||
    !env.MIKROTIK_PASSWORD
  ) {
    throw new Error("Konfigurasi MikroTik belum lengkap.");
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
