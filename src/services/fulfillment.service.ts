import { prisma } from "../lib/prisma";
import { createMikrotikUser } from "./mikrotik.service";
import { getMikrotikProfile } from "./mikrotik-profile";
import { withOrderLock } from "./order-lock.service";
import { generateStructuredVoucherCode } from "../utils/voucher-code";

async function ensureVoucherForOrder(orderId: string) {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, voucherId: true, package: { select: { id: true, code: true } } },
  });
  if (!o || o.voucherId) return;
  if (o.status !== "PAID" && o.status !== "FULFILLING") return;

  for (let attempt = 0; attempt < 20; attempt++) {
    const code = generateStructuredVoucherCode(o.package.code);
    const clash = await prisma.voucher.findFirst({
      where: { code: { equals: code, mode: "insensitive" } },
      select: { id: true },
    });
    if (clash) continue;
    await prisma.$transaction(async (tx) => {
      const v = await tx.voucher.create({
        data: { packageId: o.package.id, code, username: code, password: code, status: "RESERVED" },
      });
      const linked = await tx.order.updateMany({
        where: { id: o.id, voucherId: null, status: { in: ["PAID", "FULFILLING"] } },
        data: { voucherId: v.id },
      });
      if (linked.count !== 1) throw new Error("ORDER_VOUCHER_LINK_FAILED");
    });
    return;
  }
  throw new Error("VOUCHER_CODE_GENERATION_FAILED");
}

export async function fulfillOrder(orderId: string) {
  return withOrderLock(orderId, async () => {
    await ensureVoucherForOrder(orderId);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        package: true,
        voucher: true,
      },
    });

    if (!order) {
      throw new Error("ORDER_NOT_FOUND");
    }

    if (order.status === "FULFILLED") {
      return {
        alreadyFulfilled: true,
        order,
      };
    }

    if (order.status !== "PAID" && order.status !== "FULFILLING") {
      throw new Error(
        `ORDER_NOT_PAID: status saat ini ${order.status}`
      );
    }

    if (!order.voucher) {
      throw new Error("VOUCHER_NOT_FOUND");
    }

    const voucherId = order.voucher.id;
    const username = order.voucher.username;
    const password = order.voucher.password;
    const profile = getMikrotikProfile(order.package.code);

    // Pastikan voucher masih menjadi milik order ini.
    const voucher = await prisma.voucher.findFirst({
      where: {
        id: voucherId,
        status: "RESERVED",
        order: {
          is: { id: order.id },
        },
      },
      select: { id: true },
    });

    if (!voucher) {
      throw new Error("VOUCHER_RESERVATION_INVALID");
    }

    // Klaim hanya diperlukan untuk order yang belum pernah diklaim.
    if (order.status === "PAID") {
      const claimed = await prisma.order.updateMany({
        where: {
          id: order.id,
          status: "PAID",
          voucherId,
        },
        data: {
          status: "FULFILLING",
        },
      });

      if (claimed.count !== 1) {
        throw new Error("ORDER_FULFILLMENT_ALREADY_CLAIMED");
      }
    }

    // Provisioning idempotent di MikroTik.
    const mikrotikResult = await createMikrotikUser({
      username,
      password,
      profile,
    });

    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      const updatedVoucher = await tx.voucher.updateMany({
        where: {
          id: voucherId,
          status: "RESERVED",
          order: {
            is: { id: order.id },
          },
        },
        data: {
          status: "SOLD",
          mikrotikUsername: username,
          soldAt: now,
        },
      });

      if (updatedVoucher.count !== 1) {
        throw new Error(
          "VOUCHER_STATUS_CHANGED_DURING_FULFILLMENT"
        );
      }

      const updatedOrder = await tx.order.updateMany({
        where: {
          id: order.id,
          status: "FULFILLING",
          voucherId,
        },
        data: {
          status: "FULFILLED",
          fulfilledAt: now,
        },
      });

      if (updatedOrder.count !== 1) {
        throw new Error(
          "ORDER_STATUS_CHANGED_DURING_FULFILLMENT"
        );
      }

      await tx.auditLog.create({
        data: {
          action:
            order.status === "FULFILLING"
              ? "RECOVER_FULFILL_ORDER"
              : "FULFILL_ORDER",
          entityType: "Order",
          entityId: order.id,
          description:
            `Order ${order.orderNumber} berhasil diprovision ke MikroTik`,
          metadata: {
            mikrotikCreated: mikrotikResult.created,
            username,
            profile,
            recovered: order.status === "FULFILLING",
          },
        },
      });

      const savedOrder = await tx.order.findUniqueOrThrow({
        where: { id: order.id },
        include: {
          package: true,
          voucher: true,
        },
      });

      return {
        order: savedOrder,
        voucher: await tx.voucher.findUniqueOrThrow({
          where: { id: voucherId },
        }),
      };
    });

    return {
      alreadyFulfilled: false,
      mikrotikCreated: mikrotikResult.created,
      mikrotikUser: mikrotikResult.user,
      order: result.order,
      voucher: result.voucher,
    };
  });
}
