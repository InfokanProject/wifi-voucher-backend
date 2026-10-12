
import {
  createMikrotikUser,
  getMikrotikUser,
  simulateMikrotikActivation,
} from "../../services/mikrotik.service";
import { getMikrotikProfile } from "../../services/mikrotik-profile";

import { env } from "../../config/env";
import { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma";
import { fulfillOrder } from "../../services/fulfillment.service";

export async function paymentRoutes(app: FastifyInstance) {
  app.post<{
    Params: { orderId: string };
  }>("/api/payments/demo/:orderId/pay", async (request, reply) => {
 
    
    if (env.NODE_ENV !== "development") {
      return reply.code(404).send({
        error: "Endpoint pembayaran demo tidak tersedia."
      });
    }    

    const { orderId } = request.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        payments: true,
        voucher: true,
      },
    });

    if (!order) {
      return reply.code(404).send({
        error: "Order tidak ditemukan",
      });
    }

    if (
      order.status === "PAID" ||
      order.status === "FULFILLED"
    ) {
      return reply.code(400).send({
        error: "Order sudah dibayar",
      });
    }

    if (order.status !== "PENDING") {
      return reply.code(400).send({
        error: `Order tidak bisa dibayar karena status ${order.status}`,
      });
    }

    if (order.expiresAt && order.expiresAt < new Date()) {
      return reply.code(400).send({
        error: "Order sudah expired",
      });
    }

    const payment = order.payments.find(
      (item) => item.status === "PENDING"
    );

    if (!payment) {
      return reply.code(400).send({
        error: "Payment pending tidak ditemukan",
      });
    }

    if (!order.voucherId) {
      return reply.code(400).send({
        error: "Order tidak memiliki voucher",
      });
    }

    
    const now = new Date();
    const providerTransactionId = `DEMO-${order.orderNumber}`;

    let paymentResult: {
      order: Awaited<ReturnType<typeof prisma.order.update>>;
      payment: Awaited<ReturnType<typeof prisma.payment.update>>;
    };

    try {
      paymentResult = await prisma.$transaction(async (tx) => {
        // Klaim order hanya jika masih PENDING dan belum kedaluwarsa.
        const claimedOrder = await tx.order.updateMany({
          where: {
            id: order.id,
            status: "PENDING",
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: now } },
            ],
          },
          data: {
            status: "PAID",
            paidAt: now,
          },
        });

        if (claimedOrder.count !== 1) {
          throw new Error("ORDER_EXPIRED_OR_ALREADY_PROCESSED");
        }

        const updatedPayment = await tx.payment.updateMany({
          where: {
            id: payment.id,
            orderId: order.id,
            status: "PENDING",
          },
          data: {
            status: "PAID",
            paidAt: now,
            providerTransactionId,
          },
        });

        if (updatedPayment.count !== 1) {
          throw new Error("PAYMENT_ALREADY_PROCESSED");
        }

        const updatedOrder = await tx.order.findUniqueOrThrow({
          where: { id: order.id },
        });

        const paidPayment = await tx.payment.findUniqueOrThrow({
          where: { id: payment.id },
        });

        return {
          order: updatedOrder,
          payment: paidPayment,
        };
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "ORDER_EXPIRED_OR_ALREADY_PROCESSED"
      ) {
        return reply.code(400).send({
          error: "Order sudah kedaluwarsa atau sudah diproses",
        });
      }

      if (
        error instanceof Error &&
        error.message === "PAYMENT_ALREADY_PROCESSED"
      ) {
        return reply.code(400).send({
          error: "Payment sudah diproses atau tidak lagi pending",
        });
      }

      throw error;
    }

    try {
      const fulfillmentResult = await fulfillOrder(order.id);

      if (fulfillmentResult.alreadyFulfilled) {
        return {
          message: "Order sudah pernah dipenuhi",
          orderId: fulfillmentResult.order.id,
          orderNumber: fulfillmentResult.order.orderNumber,
          orderStatus: fulfillmentResult.order.status,
          paymentStatus: paymentResult.payment.status,
        };
      }

      return {
        message: "Pembayaran dan fulfillment berhasil",
        orderId: fulfillmentResult.order.id,
        orderNumber: fulfillmentResult.order.orderNumber,
        orderStatus: fulfillmentResult.order.status,
        paymentStatus: paymentResult.payment.status,
        mikrotikCreated: fulfillmentResult.mikrotikCreated,
        voucher: {
          code: fulfillmentResult.voucher!.code,
          status: fulfillmentResult.voucher!.status,
        },
      };
    } catch (error) {
      request.log.error(error);

      return reply.code(500).send({
        error: "Pembayaran berhasil tetapi fulfillment gagal",
        orderId: paymentResult.order.id,
        orderNumber: paymentResult.order.orderNumber,
        orderStatus: paymentResult.order.status,
        paymentStatus: paymentResult.payment.status,
      });
    }
  });
  
  
  app.post<{
    Params: { orderId: string };
  }>("/api/dev/simulator/orders/:orderId/activate", async (request, reply) => {
    if (
      env.NODE_ENV !== "development" ||
      env.MIKROTIK_MODE !== "simulator"
    ) {
      return reply.code(404).send({
        error: "Endpoint simulasi tidak tersedia.",
      });
    }

    if (request.session.get("isAdmin") !== true) {
      return reply.code(401).send({
        error: "Akses admin diperlukan.",
      });
    }

    const { orderId } = request.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        package: true,
        voucher: true,
      },
    });

    if (!order) {
      return reply.code(404).send({
        error: "Order tidak ditemukan.",
      });
    }

    if (order.status !== "FULFILLED" || !order.voucher) {
      return reply.code(409).send({
        error: "Order harus FULFILLED dan memiliki voucher.",
      });
    }

    const voucher = order.voucher;

    if (voucher.status !== "SOLD") {
      return reply.code(409).send({
        error: `Voucher harus berstatus SOLD. Status saat ini: ${voucher.status}.`,
      });
    }

    const username = voucher.username;
    const existingUser = await getMikrotikUser(username);

    if (
      existingUser &&
      String(existingUser.comment ?? "").startsWith("ACTIVATED ")
    ) {
      return reply.code(409).send({
        error: "Voucher sudah diaktifkan.",
      });
    }

    if (!existingUser) {
      await createMikrotikUser({
        username,
        password: voucher.password,
        profile: getMikrotikProfile(order.package.code),
      });
    }

    await simulateMikrotikActivation(username);

    return reply.send({
      ok: true,
      message: "Aktivasi voucher berhasil disimulasikan.",
      orderNumber: order.orderNumber,
      voucherStatus: "SOLD",
      activation: "SIMULATED",
      note: "Sinkronisasi background akan memperbarui status voucher menjadi ACTIVATED.",
    });
  });

    
  app.post<{
    Params: { orderId: string };
    Body: { reference?: string };
  }>("/api/admin/orders/:orderId/confirm-payment", async (request, reply) => {
    if (request.session.get("isAdmin") !== true) {
      return reply.code(401).send({
        error: "Akses admin diperlukan.",
      });
    }

    const { orderId } = request.params;
    const reference =
      typeof request.body?.reference === "string"
        ? request.body.reference.trim()
        : "";

    if (reference.length > 120) {
      return reply.code(400).send({
        error: "Referensi pembayaran maksimal 120 karakter.",
      });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        payments: true,
        voucher: true,
      },
    });

    if (!order) {
      return reply.code(404).send({
        error: "Order tidak ditemukan.",
      });
    }

    if (order.status !== "PENDING") {
      return reply.code(409).send({
        error: `Order tidak bisa dikonfirmasi. Status saat ini: ${order.status}.`,
      });
    }

    const now = new Date();

    if (order.expiresAt && order.expiresAt <= now) {
      return reply.code(409).send({
        error: "Order sudah kedaluwarsa. Pembayaran tidak dikonfirmasi.",
      });
    }

    if (!order.voucherId || !order.voucher) {
      return reply.code(409).send({
        error: "Order tidak memiliki voucher yang terreservasi.",
      });
    }

    const payment = order.payments.find(
      (item) => item.status === "PENDING",
    );

    if (!payment) {
      return reply.code(409).send({
        error: "Payment pending tidak ditemukan.",
      });
    }

    if (payment.amount !== order.amount) {
      return reply.code(409).send({
        error: "Nominal payment tidak sesuai dengan nominal order.",
      });
    }

    try {
      await prisma.$transaction(async (tx) => {
        const claimedOrder = await tx.order.updateMany({
          where: {
            id: order.id,
            status: "PENDING",
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: now } },
            ],
          },
          data: {
            status: "PAID",
            paidAt: now,
          },
        });

        if (claimedOrder.count !== 1) {
          throw new Error("ORDER_ALREADY_PROCESSED_OR_EXPIRED");
        }

        const updatedPayment = await tx.payment.updateMany({
          where: {
            id: payment.id,
            orderId: order.id,
            status: "PENDING",
            amount: order.amount,
          },
          data: {
            status: "PAID",
            paidAt: now,
          },
        });

        if (updatedPayment.count !== 1) {
          throw new Error("PAYMENT_ALREADY_PROCESSED");
        }

        await tx.auditLog.create({
          data: {
            action: "CONFIRM_MANUAL_PAYMENT",
            entityType: "Order",
            entityId: order.id,
            description: `Pembayaran manual order ${order.orderNumber} dikonfirmasi oleh admin`,
            metadata: {
              orderNumber: order.orderNumber,
              paymentId: payment.id,
              amount: order.amount,
              method: payment.method,
              reference: reference || null,
            },
          },
        });
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "ORDER_ALREADY_PROCESSED_OR_EXPIRED"
      ) {
        return reply.code(409).send({
          error: "Order sudah diproses atau kedaluwarsa.",
        });
      }

      if (
        error instanceof Error &&
        error.message === "PAYMENT_ALREADY_PROCESSED"
      ) {
        return reply.code(409).send({
          error: "Payment sudah diproses atau nominalnya tidak sesuai.",
        });
      }

      throw error;
    }

    try {
      const result = await fulfillOrder(order.id);

      return reply.send({
        ok: true,
        message: result.alreadyFulfilled
          ? "Order sudah terpenuhi."
          : "Pembayaran dikonfirmasi dan fulfillment berhasil.",
        orderId: result.order.id,
        orderNumber: result.order.orderNumber,
        orderStatus: result.order.status,
        paymentStatus: "PAID",
        mikrotikCreated: result.alreadyFulfilled
          ? undefined
          : result.mikrotikCreated,
      });
    } catch (error) {
      request.log.error(error);

      return reply.code(500).send({
        ok: false,
        error: "Pembayaran tercatat, tetapi fulfillment gagal. Periksa status order sebelum mencoba pemulihan.",
        orderId: order.id,
        orderNumber: order.orderNumber,
      });
    }
  });

}