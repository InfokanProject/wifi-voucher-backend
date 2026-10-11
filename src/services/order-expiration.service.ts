
import { prisma } from "../lib/prisma";

export async function expireDueOrders() {
  const now = new Date();

  const dueOrders = await prisma.order.findMany({
    where: {
      status: "PENDING",
      expiresAt: {
        lte: now,
      },
    },
    include: {
      voucher: true,
    },
  });

  let expired = 0;
  let vouchersReleased = 0;

  for (const order of dueOrders) {
    const result = await prisma.$transaction(async (tx) => {
      // Klaim order hanya jika masih PENDING dan benar-benar due.
      const updatedOrder = await tx.order.updateMany({
        where: {
          id: order.id,
          status: "PENDING",
          expiresAt: {
            lte: now,
          },
        },
        data: {
          status: "EXPIRED",
        },
      });

      if (updatedOrder.count !== 1) {
        return { expired: false, voucherReleased: false };
      }

      await tx.payment.updateMany({
        where: {
          orderId: order.id,
          status: "PENDING",
        },
        data: {
          status: "EXPIRED",
        },
      });

      let voucherReleased = false;
      const voucher = order.voucher;

      if (
        voucher &&
        voucher.status === "RESERVED" &&
        voucher.reservedUntil !== null &&
        voucher.reservedUntil <= now
      ) {
        // Lepas hanya jika voucher masih terikat pada order ini.
        const updatedVoucher = await tx.voucher.updateMany({
          where: {
            id: voucher.id,
            status: "RESERVED",
            reservedUntil: {
              lte: now,
            },
            order: {
              is: {
                id: order.id,
                status: "EXPIRED",
              },
            },
          },
          data: {
            status: "STOCK",
            reservedUntil: null,
          },
        });

        if (updatedVoucher.count === 1) {
          
          const detachedOrder = await tx.order.updateMany({
            where: {
              id: order.id,
              status: "EXPIRED",
              voucherId: voucher.id,
            },
            data: {
              voucherId: null,
            },
          });

          if (detachedOrder.count !== 1) {
            throw new Error(
              `Gagal melepas relasi voucher dari order ${order.orderNumber}`
            );
          }

          voucherReleased = true;
   
        }
      }

      await tx.auditLog.create({
        data: {
          action: "EXPIRE_ORDER",
          entityType: "Order",
          entityId: order.id,
          description: `Order ${order.orderNumber} kedaluwarsa`,
          metadata: {
            orderNumber: order.orderNumber,
            voucherId: order.voucherId,
            voucherCode: voucher?.code ?? null,
            voucherUsername: voucher?.username ?? null,
            voucherReleased,
            expiredAt: now.toISOString(),
            source: "database-order-expiration-job",
          },
        },
      });

      return { expired: true, voucherReleased };
    });

    if (result.expired) expired++;
    if (result.voucherReleased) vouchersReleased++;
  }

  return {
    checkedAt: now,
    found: dueOrders.length,
    expired,
    vouchersReleased,
  };
}