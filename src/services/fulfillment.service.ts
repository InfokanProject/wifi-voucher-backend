import { prisma } from "../lib/prisma";
import { createMikrotikUser } from "./mikrotik.service";
import { getMikrotikProfile } from "./mikrotik-profile";

export async function fulfillOrder(orderId: string) {
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

  if (order.status !== "PAID") {
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

  // Klaim order dan validasi voucher secara atomik.
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.order.updateMany({
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

    const voucher = await tx.voucher.findFirst({
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
  });

  // Provisioning dilakukan di luar transaksi database.
  // Jika proses gagal, order tetap FULFILLING untuk rekonsiliasi.
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
      },
      data: {
        status: "SOLD",
        mikrotikUsername: username,
        soldAt: now,
      },
    });

    if (updatedVoucher.count !== 1) {
      throw new Error("VOUCHER_STATUS_CHANGED_DURING_FULFILLMENT");
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
      throw new Error("ORDER_STATUS_CHANGED_DURING_FULFILLMENT");
    }

    await tx.auditLog.create({
      data: {
        action: "FULFILL_ORDER",
        entityType: "Order",
        entityId: order.id,
        description: `Order ${order.orderNumber} berhasil diprovision ke MikroTik`,
        metadata: {
          mikrotikCreated: mikrotikResult.created,
          username,
          profile,
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
}
