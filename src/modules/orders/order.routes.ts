import { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma";
import { makeOrderNumber } from "../../utils/order-number";

export async function orderRoutes(app: FastifyInstance) {
  // Membuat order dan mereservasi satu voucher selama 15 menit.
  app.post<{
    Body: { packageCode: string; customerIdentifier?: string };
  }>("/api/orders", async (request, reply) => {
    const { packageCode, customerIdentifier } = request.body;

    const pkg = await prisma.package.findUnique({
      where: { code: packageCode },
    });

    if (!pkg || !pkg.isActive) {
      return reply.code(404).send({
        error: "Paket tidak tersedia",
      });
    }

    const now = new Date();
    const reservedUntil = new Date(now.getTime() + 15 * 60 * 1000);

    const result = await prisma.$transaction(async (tx) => {
      let reservedOrder = null;

      for (let attempt = 0; attempt < 10; attempt++) {
        const voucher = await tx.voucher.findFirst({
          where: {
            packageId: pkg.id,
            order: { is: null },
            OR: [
              { status: "STOCK" },
              {
                status: "RESERVED",
                reservedUntil: { lt: now },
              },
            ],
          },
          orderBy: { createdAt: "asc" },
        });

        if (!voucher) {
          throw new Error("STOK_VOUCHER_HABIS");
        }

        const claim = await tx.voucher.updateMany({
          where: {
            id: voucher.id,
            packageId: pkg.id,
            order: { is: null },
            OR: [
              { status: "STOCK" },
              {
                status: "RESERVED",
                reservedUntil: { lt: now },
              },
            ],
          },
          data: {
            status: "RESERVED",
            reservedUntil,
          },
        });

        if (claim.count !== 1) {
          continue;
        }

        const order = await tx.order.create({
          data: {
            orderNumber: makeOrderNumber(),
            packageId: pkg.id,
            voucherId: voucher.id,
            customerIdentifier,
            amount: pkg.price,
            expiresAt: reservedUntil,
          },
          include: {
            package: true,
          },
        });

        await tx.payment.create({
          data: {
            orderId: order.id,
            provider: "DEMO",
            method: "MANUAL",
            amount: pkg.price,
          },
        });

        reservedOrder = order;
        break;
      }

      if (!reservedOrder) {
        throw new Error("RESERVASI_VOUCHER_GAGAL_Coba_lagi");
      }

      return reservedOrder;
    });

    // Jangan kirim kode voucher sebelum pembayaran terverifikasi.
    return {
      orderId: result.id,
      orderNumber: result.orderNumber,
      status: result.status,
      amount: result.amount,
      package: result.package.code,
      expiresAt: result.expiresAt,
    };
  });

  // Daftar order khusus admin yang sudah login.
  app.get("/api/admin/orders", async (request, reply) => {
    if (request.session.get("isAdmin") !== true) {
      return reply.code(401).send({
        error: "Akses admin diperlukan.",
      });
    }

    const orders = await prisma.order.findMany({
      take: 100,
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        orderNumber: true,
        amount: true,
        status: true,
        expiresAt: true,
        paidAt: true,
        fulfilledAt: true,
        createdAt: true,
        package: {
          select: {
            code: true,
            name: true,
          },
        },
        payments: {
          select: {
            status: true,
            method: true,
            amount: true,
            paidAt: true,
          },
        },
      },
    });

    return reply.send({
      total: orders.length,
      orders,
    });
  });

  // Detail order publik dengan field terbatas.
  app.get<{ Params: { id: string } }>(
    "/api/orders/:id",
    async (request, reply) => {
      const order = await prisma.order.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          orderNumber: true,
          amount: true,
          status: true,
          expiresAt: true,
          paidAt: true,
          fulfilledAt: true,
          createdAt: true,
          package: {
            select: {
              code: true,
              name: true,
              durationMinutes: true,
              speedMbps: true,
            },
          },
          payments: {
            select: {
              status: true,
              method: true,
              amount: true,
              paidAt: true,
            },
          },
        },
      });

      if (!order) {
        return reply.code(404).send({
          error: "Order tidak ditemukan",
        });
      }

      return reply.send(order);
    }
  );
}