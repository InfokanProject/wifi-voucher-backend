
import { prisma } from "../lib/prisma";

export async function expireDueVouchers() {
  const now = new Date();

  const dueVouchers = await prisma.voucher.findMany({
    where: {
      status: "ACTIVATED",
      expiresAt: {
        lte: now,
      },
    },
    select: {
      id: true,
      username: true,
      expiresAt: true,
    },
  });

  let expired = 0;

  for (const voucher of dueVouchers) {
    const didExpire = await prisma.$transaction(async (tx) => {
      const result = await tx.voucher.updateMany({
        where: {
          id: voucher.id,
          status: "ACTIVATED",
          expiresAt: {
            lte: now,
          },
        },
        data: {
          status: "EXPIRED",
          expiredAt: now,
        },
      });

      if (result.count !== 1) {
        return false;
      }

      await tx.auditLog.create({
        data: {
          action: "EXPIRE_VOUCHER",
          entityType: "Voucher",
          entityId: voucher.id,
          description: `Voucher ${voucher.username} otomatis kedaluwarsa`,
          metadata: {
            username: voucher.username,
            expiresAt: voucher.expiresAt?.toISOString() ?? null,
            expiredAt: now.toISOString(),
            source: "database-expiration-job",
          },
        },
      });

      return true;
    });

    if (didExpire) {
      expired++;
    }
  }

  return {
    checkedAt: now,
    found: dueVouchers.length,
    expired,
  };
}
