import { prisma } from "../lib/prisma";
import { fulfillOrder } from "./fulfillment.service";

const STUCK_AFTER_MS = 3 * 60 * 1000;
const MAX_PER_RUN = 10;
const FAILURE_LOG_COOLDOWN_MS = 30 * 60 * 1000;

export async function recoverStuckOrders() {
  const now = new Date();

  const stuckOrders = await prisma.order.findMany({
    where: {
      status: { in: ["PAID", "FULFILLING"] },
      winningPaymentId: { not: null },
      paidAt: { lte: new Date(now.getTime() - STUCK_AFTER_MS) },
    },
    orderBy: { paidAt: "asc" },
    take: MAX_PER_RUN,
    select: { id: true, orderNumber: true },
  });

  let recovered = 0;
  let skipped = 0;
  let failed = 0;

  // Berurutan, bukan paralel: melindungi router dan pool koneksi.
  for (const order of stuckOrders) {
    try {
      await fulfillOrder(order.id);
      recovered++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("ORDER_FULFILLMENT_ALREADY_CLAIMED")) {
        skipped++;
        continue;
      }

      failed++;

      const recentLog = await prisma.auditLog.findFirst({
        where: {
          action: "RECOVERY_FULFILLMENT_FAILED",
          entityType: "Order",
          entityId: order.id,
          createdAt: { gte: new Date(now.getTime() - FAILURE_LOG_COOLDOWN_MS) },
        },
        select: { id: true },
      });

      if (!recentLog) {
        await prisma.auditLog.create({
          data: {
            action: "RECOVERY_FULFILLMENT_FAILED",
            entityType: "Order",
            entityId: order.id,
            description: `Pemulihan fulfillment order ${order.orderNumber} gagal.`,
            metadata: { orderNumber: order.orderNumber, error: message },
          },
        });
      }
    }
  }

  return { checkedAt: now, found: stuckOrders.length, recovered, skipped, failed };
}
