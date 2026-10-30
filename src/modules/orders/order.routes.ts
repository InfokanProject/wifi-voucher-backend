import { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma";
import { makeOrderNumber } from "../../utils/order-number";

export async function orderRoutes(app: FastifyInstance) {
  
  // Membuat order dengan idempotency key dan reservasi voucher 15 menit.
  app.post<{
    Body: {
      packageCode: string;
      customerIdentifier?: string;
      idempotencyKey?: string;
    };
  }>("/api/orders", async (request, reply) => {
    const { packageCode, customerIdentifier } = request.body;
    const idempotencyKey = request.body.idempotencyKey?.trim();

    if (
      !idempotencyKey ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 80
    ) {
      return reply.code(400).send({
        error: "IDEMPOTENCY_KEY_INVALID",
        message: "Kunci pesanan wajib diisi dan harus 8–80 karakter.",
      });
    }

    // Kunci yang sama harus mengembalikan order yang sama.
    const existingOrder = await prisma.order.findUnique({
      where: { idempotencyKey },
      include: { package: true },
    });

    if (existingOrder) {
      if (
        existingOrder.package.code !== packageCode ||
        (existingOrder.customerIdentifier ?? "") !==
          (customerIdentifier?.trim() ?? "")
      ) {
        return reply.code(409).send({
          error: "IDEMPOTENCY_KEY_REUSED",
          message: "Kunci pesanan sudah digunakan untuk data berbeda.",
        });
      }

      return reply.send({
        orderId: existingOrder.id,
        orderNumber: existingOrder.orderNumber,
        status: existingOrder.status,
        amount: existingOrder.amount,
        package: existingOrder.package.code,
        expiresAt: existingOrder.expiresAt,
      });
    }

    const pkg = await prisma.package.findUnique({
      where: { code: packageCode },
    });

    if (!pkg || !pkg.isActive) {
      return reply.code(404).send({
        error: "Paket tidak tersedia",
      });
    }

    const now = new Date();
    const reservedUntil = new Date(now.getTime() + 60 * 60 * 1000);

    try {
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
              idempotencyKey,
              packageId: pkg.id,
              voucherId: voucher.id,
              customerIdentifier: customerIdentifier?.trim() || null,
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

      return reply.send({
        orderId: result.id,
        orderNumber: result.orderNumber,
        status: result.status,
        amount: result.amount,
        package: result.package.code,
        expiresAt: result.expiresAt,
      });
    } catch (error) {
      // Jika request bersamaan memakai kunci sama, transaksi
      // yang kalah dibatalkan; ambil order yang berhasil dibuat.
      const code = (error as { code?: string }).code;

      if (code === "P2002") {
        const duplicate = await prisma.order.findUnique({
          where: { idempotencyKey },
          include: { package: true },
        });

        if (duplicate) {
          if (
            duplicate.package.code !== packageCode ||
            (duplicate.customerIdentifier ?? "") !==
              (customerIdentifier?.trim() ?? "")
          ) {
            return reply.code(409).send({
              error: "IDEMPOTENCY_KEY_REUSED",
              message: "Kunci pesanan sudah digunakan untuk data berbeda.",
            });
          }

          return reply.send({
            orderId: duplicate.id,
            orderNumber: duplicate.orderNumber,
            status: duplicate.status,
            amount: duplicate.amount,
            package: duplicate.package.code,
            expiresAt: duplicate.expiresAt,
          });
        }
      }

      if (
        error instanceof Error &&
        error.message === "STOK_VOUCHER_HABIS"
      ) {
        return reply.code(409).send({
          error: "STOK_VOUCHER_HABIS",
          message: "Stok voucher paket ini sedang habis.",
        });
      }

      throw error;
    }
  });


    // Statistik ringkas untuk dashboard owner.
  app.get("/api/admin/dashboard/stats", async (request, reply) => {
    if (request.session.get("isAdmin") !== true) {
      return reply.code(401).send({
        error: "Akses admin diperlukan.",
      });
    }

        const [
      voucherStock,
      voucherReserved,
      voucherActivated,
      ordersPending,
      ordersFulfilled,
      paymentsPaid,
      revenue,
    ] = await Promise.all([
      prisma.voucher.count({
        where: { status: "STOCK" },
      }),
      prisma.voucher.count({
        where: { status: "RESERVED" },
      }),
      prisma.voucher.count({
        where: { status: "ACTIVATED" },
      }),
      prisma.order.count({
        where: { status: "PENDING" },
      }),
      prisma.order.count({
        where: { status: "FULFILLED" },
      }),
      prisma.payment.count({
        where: { status: "PAID" },
      }),
      prisma.payment.aggregate({
        where: { status: "PAID" },
        _sum: { amount: true },
      }),
    ]);

      return reply.send({
      voucherStock,
      voucherReserved,
      voucherActivated,
      ordersPending,
      ordersFulfilled,
      paymentsPaid,
      revenuePaid: Number(revenue._sum.amount ?? 0),
    });
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
    provider: true,
    providerTransactionId: true,
    status: true,
    method: true,
    amount: true,
    paidAt: true,
    rawResponse: true,
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
     const identifier = request.params.id;

const isUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    identifier
  );

const order = await prisma.order.findFirst({
  where: isUuid
    ? { id: identifier }
    : { orderNumber: identifier },
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
          voucher: {
            select: {
              code: true,
              username: true,
              status: true,
              activatedAt: true,
              expiresAt: true,
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

      const { voucher, ...safeOrder } = order;

      return reply.send({
        ...safeOrder,
        voucher: order.status === "FULFILLED" ? voucher : null,
      });
    }
  );
}