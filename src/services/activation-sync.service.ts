
import { prisma } from "../lib/prisma";
import { getMikrotikUsers } from "./mikrotik.service";
import {
  calculateExpiresAt,
  parseActivationTime,
} from "./voucher-expiry";

export async function syncAllVoucherActivations() {
  let synced = 0;
  let backfilled = 0;
  let expired = 0;
  let alreadyActivated = 0;
  let legacy = 0;

  // Backfill database terlebih dahulu agar tidak bergantung
  // pada koneksi MikroTik.
  const vouchersNeedingBackfill = await prisma.voucher.findMany({
    where: {
      status: "ACTIVATED",
      activatedAt: { not: null },
      expiresAt: null,
    },
    include: { package: true },
  });

  for (const voucher of vouchersNeedingBackfill) {
    if (!voucher.activatedAt) continue;

    const expiresAt = calculateExpiresAt(
      voucher.activatedAt,
      voucher.package.durationMinutes
    );

    const now = new Date();

    if (expiresAt.getTime() <= now.getTime()) {
      const didExpire = await prisma.$transaction(async (tx) => {
        const result = await tx.voucher.updateMany({
          where: {
            id: voucher.id,
            status: "ACTIVATED",
            activatedAt: voucher.activatedAt,
            expiresAt: null,
          },
          data: {
            status: "EXPIRED",
            expiresAt,
            expiredAt: voucher.expiredAt ?? now,
          },
        });

        if (result.count !== 1) return false;

        await tx.auditLog.create({
          data: {
            action: "EXPIRE_VOUCHER",
            entityType: "Voucher",
            entityId: voucher.id,
            description: `Voucher ${voucher.username} otomatis kedaluwarsa saat backfill`,
            metadata: {
              username: voucher.username,
              activatedAt: voucher.activatedAt!.toISOString(),
              expiresAt: expiresAt.toISOString(),
              source: "database-backfill",
            },
          },
        });

        return true;
      });

      if (didExpire) expired++;

      continue;
    }

    const didBackfill = await prisma.$transaction(async (tx) => {
      const result = await tx.voucher.updateMany({
        where: {
          id: voucher.id,
          status: "ACTIVATED",
          activatedAt: voucher.activatedAt,
          expiresAt: null,
        },
        data: { expiresAt },
      });

      if (result.count !== 1) return false;

      await tx.auditLog.create({
        data: {
          action: "BACKFILL_VOUCHER_EXPIRY",
          entityType: "Voucher",
          entityId: voucher.id,
          description: `Data masa aktif voucher ${voucher.username} dilengkapi`,
          metadata: {
            username: voucher.username,
            activatedAt: voucher.activatedAt!.toISOString(),
            expiresAt: expiresAt.toISOString(),
            source: "database-backfill",
          },
        },
      });

      return true;
    });

    if (didBackfill) backfilled++;
  }

  // Setelah backfill database selesai, baru hubungi MikroTik.
  const users = await getMikrotikUsers();

  const activatedUsers = users.filter((user: any) =>
    String(user.comment ?? "").startsWith("ACTIVATED")
  );

  for (const user of activatedUsers) {
    const username = String(user.name);
    const comment = String(user.comment ?? "");

    const voucher = await prisma.voucher.findUnique({
      where: { username },
      include: { package: true },
    });

    if (!voucher) {
      legacy++;
      continue;
    }

    if (
      voucher.status === "EXPIRED" ||
      voucher.status === "DISABLED"
    ) {
      continue;
    }

    if (
      voucher.status !== "SOLD" &&
      voucher.status !== "ACTIVATED"
    ) {
      continue;
    }

    const parsedActivation = parseActivationTime(comment);
    const activationTime =
      voucher.activatedAt ?? parsedActivation;

    if (!activationTime) continue;

    const expiresAt =
      voucher.expiresAt ??
      calculateExpiresAt(
        activationTime,
        voucher.package.durationMinutes
      );

    const now = new Date();

    if (expiresAt.getTime() <= now.getTime()) {
      const didExpire = await prisma.$transaction(async (tx) => {
        const result = await tx.voucher.updateMany({
          where: {
            id: voucher.id,
            status: voucher.status,
            activatedAt: voucher.activatedAt,
            expiresAt: voucher.expiresAt,
          },
          data: {
            status: "EXPIRED",
            activatedAt: voucher.activatedAt ?? activationTime,
            expiresAt,
            expiredAt: voucher.expiredAt ?? now,
          },
        });

        if (result.count !== 1) return false;

        await tx.auditLog.create({
          data: {
            action: "EXPIRE_VOUCHER",
            entityType: "Voucher",
            entityId: voucher.id,
            description: `Voucher ${username} tercatat kedaluwarsa`,
            metadata: {
              username,
              activatedAt: activationTime.toISOString(),
              expiresAt: expiresAt.toISOString(),
              source: "activation-sync",
            },
          },
        });

        return true;
      });

      if (didExpire) expired++;

      continue;
    }

    const isNewActivation = voucher.status === "SOLD";
    const needsBackfill =
      !voucher.activatedAt || !voucher.expiresAt;

    if (!isNewActivation && !needsBackfill) {
      alreadyActivated++;
      continue;
    }

    const didUpdate = await prisma.$transaction(async (tx) => {
      const result = await tx.voucher.updateMany({
        where: {
          id: voucher.id,
          status: voucher.status,
          activatedAt: voucher.activatedAt,
          expiresAt: voucher.expiresAt,
        },
        data: {
          status: "ACTIVATED",
          activatedAt: voucher.activatedAt ?? activationTime,
          expiresAt,
        },
      });

      if (result.count !== 1) return false;

      await tx.auditLog.create({
        data: {
          action: isNewActivation
            ? "SYNC_VOUCHER_ACTIVATION"
            : "BACKFILL_VOUCHER_EXPIRY",
          entityType: "Voucher",
          entityId: voucher.id,
          description: isNewActivation
            ? `Voucher ${username} otomatis terdeteksi ACTIVATED di MikroTik`
            : `Data masa aktif voucher ${username} dilengkapi`,
          metadata: {
            username,
            mikrotikComment: comment,
            activatedAt: activationTime.toISOString(),
            expiresAt: expiresAt.toISOString(),
          },
        },
      });

      return true;
    });

    if (!didUpdate) continue;

    if (isNewActivation) {
      synced++;
    } else {
      backfilled++;
    }
  }

  return {
    mikrotikActivatedUsers: activatedUsers.length,
    synced,
    backfilled,
    expired,
    alreadyActivated,
    legacy,
  };
}
