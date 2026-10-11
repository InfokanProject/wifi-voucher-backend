
import { prisma } from "../lib/prisma";
import { getMikrotikUser } from "./mikrotik.service";
import {
  calculateExpiresAt,
  parseActivationTime,
} from "./voucher-expiry";

export async function syncVoucherActivation(username: string) {
  const voucher = await prisma.voucher.findUnique({
    where: { username },
    include: { package: true },
  });

  if (!voucher) {
    throw new Error("VOUCHER_NOT_FOUND");
  }

  if (
    voucher.status === "EXPIRED" ||
    voucher.status === "DISABLED"
  ) {
    return {
      synced: false,
      reason: voucher.status,
      voucher,
    };
  }

  const mikrotikUser = await getMikrotikUser(username);

  if (!mikrotikUser) {
    throw new Error("MIKROTIK_USER_NOT_FOUND");
  }

  const comment = String(mikrotikUser.comment ?? "");

  if (!comment.startsWith("ACTIVATED")) {
    return {
      synced: false,
      reason: "NOT_ACTIVATED",
      voucher,
      mikrotikUser,
    };
  }

  if (
    voucher.status !== "SOLD" &&
    voucher.status !== "ACTIVATED"
  ) {
    throw new Error(
      `INVALID_VOUCHER_STATUS: ${voucher.status}`
    );
  }

  if (
    voucher.status === "ACTIVATED" &&
    voucher.activatedAt &&
    voucher.expiresAt
  ) {
    return {
      synced: false,
      reason: "ALREADY_ACTIVATED",
      voucher,
      mikrotikUser,
    };
  }

  const activationTime =
  voucher.activatedAt ??
  parseActivationTime(comment);

if (!activationTime) {
  return {
    synced: false,
    reason: "ACTIVATION_TIME_UNKNOWN",
    voucher,
    mikrotikUser,
  };
}

  const expiresAt =
    voucher.expiresAt ??
    calculateExpiresAt(
      activationTime,
      voucher.package.durationMinutes
    );

  const now = new Date();
  const isExpired = expiresAt.getTime() <= now.getTime();
  const isNewActivation = voucher.status === "SOLD";

  const updatedVoucher = await prisma.voucher.update({
    where: { id: voucher.id },
    data: {
      status: isExpired ? "EXPIRED" : "ACTIVATED",
      activatedAt: voucher.activatedAt ?? activationTime,
      expiresAt,
      ...(isExpired
        ? { expiredAt: voucher.expiredAt ?? now }
        : {}),
    },
  });

  await prisma.auditLog.create({
    data: {
      action: isExpired
        ? "EXPIRE_VOUCHER"
        : isNewActivation
          ? "SYNC_VOUCHER_ACTIVATION"
          : "BACKFILL_VOUCHER_EXPIRY",
      entityType: "Voucher",
      entityId: voucher.id,
      description: isExpired
        ? `Voucher ${username} tercatat kedaluwarsa`
        : isNewActivation
          ? `Voucher ${username} terdeteksi ACTIVATED di MikroTik`
          : `Data masa aktif voucher ${username} dilengkapi`,
      metadata: {
        username,
        mikrotikComment: comment,
        activatedAt: activationTime.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    },
  });

  return {
    synced: isNewActivation && !isExpired,
    reason: isExpired
      ? "EXPIRED"
      : isNewActivation
        ? "ACTIVATED"
        : "BACKFILLED",
    voucher: updatedVoucher,
    mikrotikUser,
  };
}