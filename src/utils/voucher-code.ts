import crypto from "node:crypto";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Format: kode paket + 4 digit acak + 1 huruf acak. Contoh: 12J7135e, 7H4266P.
export function generateStructuredVoucherCode(packageCode: string): string {
  const digits = crypto.randomInt(0, 10000).toString().padStart(4, "0");
  const letter = LETTERS[crypto.randomInt(0, LETTERS.length)];
  return `${packageCode}${digits}${letter}`;
}
