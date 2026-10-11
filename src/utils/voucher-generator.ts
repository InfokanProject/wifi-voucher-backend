import crypto from "node:crypto";

export function generateVoucherCode(length = 8): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(length);
  let code = "";

  for (let i = 0; i < length; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }

  return code;
}
