import { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma";
import { makeOrderNumber } from "../../utils/order-number";
import { env } from "../../config/env";
import { fulfillOrder } from "../../services/fulfillment.service";

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

  
  // Penjualan tunai langsung oleh admin.
  app.post<{
    Body: {
      packageCode: string;
      customerIdentifier?: string;
      idempotencyKey: string;
    };
  }>("/api/admin/cash-sales", async (request, reply) => {
    if (request.session.get("isAdmin") !== true) {
      return reply.code(401).send({
        error: "Akses admin diperlukan.",
      });
    }

    const packageCode = request.body?.packageCode?.trim();
    const customerIdentifier =
      request.body?.customerIdentifier?.trim() || "";
    const idempotencyKey = request.body?.idempotencyKey?.trim();

    if (!packageCode) {
      return reply.code(400).send({
        error: "Paket wajib dipilih.",
      });
    }

    if (
      !idempotencyKey ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 80
    ) {
      return reply.code(400).send({
        error: "IDEMPOTENCY_KEY_INVALID",
      });
    }

    if (customerIdentifier.length > 120) {
      return reply.code(400).send({
        error: "Identitas pembeli maksimal 120 karakter.",
      });
    }

    const existingOrder = await prisma.order.findUnique({
      where: { idempotencyKey },
      include: { package: true, voucher: true },
    });

    if (existingOrder) {
      if (
        existingOrder.package.code !== packageCode ||
        (existingOrder.customerIdentifier ?? "") !== customerIdentifier
      ) {
        return reply.code(409).send({
          error: "Kunci penjualan sudah digunakan untuk data berbeda.",
        });
      }

      if (existingOrder.status !== "PAID" &&
          existingOrder.status !== "FULFILLING" &&
          existingOrder.status !== "FULFILLED") {
        return reply.code(409).send({
          error: `Status order tidak dapat diproses: ${existingOrder.status}`,
        });
      }

      try {
        const result = await fulfillOrder(existingOrder.id);

        return reply.send({
          ok: true,
          message: result.alreadyFulfilled
            ? "Penjualan ini sudah berhasil diproses."
            : "Penjualan tunai berhasil diproses.",
          orderId: existingOrder.id,
          orderNumber: existingOrder.orderNumber,
          voucherCode: result.order.voucher?.code ?? result.voucher?.code,
          amount: existingOrder.amount,
          package: existingOrder.package.code,
        });
      } catch (error) {
        request.log.error(error);

        return reply.code(202).send({
          ok: false,
          fulfillmentPending: true,
          message: "Pembayaran tercatat, tetapi provisioning MikroTik belum berhasil. Silakan coba ulang.",
          orderId: existingOrder.id,
          orderNumber: existingOrder.orderNumber,
        });
      }
    }

    const pkg = await prisma.package.findUnique({
      where: { code: packageCode },
    });

    if (!pkg || !pkg.isActive) {
      return reply.code(404).send({
        error: "Paket tidak tersedia.",
      });
    }

    const now = new Date();

    let order;

    try {
      order = await prisma.$transaction(async (tx) => {
        let reservedOrder = null;

        for (let attempt = 0; attempt < 10; attempt++) {
          const voucher = await tx.voucher.findFirst({
            where: {
              packageId: pkg.id,
              status: "STOCK",
              order: { is: null },
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
              status: "STOCK",
              order: { is: null },
            },
            data: {
              status: "RESERVED",
              reservedUntil: null,
            },
          });

          if (claim.count !== 1) {
            continue;
          }

          const createdOrder = await tx.order.create({
            data: {
              orderNumber: makeOrderNumber(),
              idempotencyKey,
              packageId: pkg.id,
              voucherId: voucher.id,
              customerIdentifier: customerIdentifier || null,
              amount: pkg.price,
              status: "PAID",
              paidAt: now,
              expiresAt: null,
            },
            include: {
              package: true,
              voucher: true,
            },
          });

          await tx.payment.create({
            data: {
              orderId: createdOrder.id,
              provider: "CASH",
              method: "MANUAL",
              amount: pkg.price,
              status: "PAID",
              paidAt: now,
              providerTransactionId: `CASH-${createdOrder.orderNumber}`,
            },
          });

          reservedOrder = createdOrder;
          break;
        }

        if (!reservedOrder) {
          throw new Error("RESERVASI_VOUCHER_GAGAL");
        }

        return reservedOrder;
      });
    } catch (error) {
      const code = (error as { code?: string }).code;

      if (code === "P2002") {
        return reply.code(409).send({
          error: "Penjualan dengan kunci tersebut sudah diproses. Muat ulang data order.",
        });
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

      request.log.error(error);

      return reply.code(500).send({
        error: "Gagal membuat penjualan tunai.",
      });
    }

    try {
      const result = await fulfillOrder(order.id);

      return reply.code(201).send({
        ok: true,
        message: "Penjualan tunai berhasil diproses.",
        orderId: order.id,
        orderNumber: order.orderNumber,
        voucherCode: result.voucher?.code,
        amount: order.amount,
        package: order.package.code,
      });
    } catch (error) {
      request.log.error(error);

      return reply.code(202).send({
        ok: false,
        fulfillmentPending: true,
        message: "Pembayaran tercatat, tetapi provisioning MikroTik belum berhasil. Silakan coba ulang.",
        orderId: order.id,
        orderNumber: order.orderNumber,
        amount: order.amount,
        package: order.package.code,
      });
    }
  });

  // Retry provisioning voucher ke MikroTik.
app.post<{
  Params: {
    orderId: string;
  };
}>("/api/admin/orders/:orderId/retry-fulfillment", async (request, reply) => {
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
      payments: true,
    },
  });

  if (!order) {
    return reply.code(404).send({
      error: "Order tidak ditemukan.",
    });
  }

  if (order.status === "FULFILLED") {
    return reply.send({
      ok: true,
      alreadyFulfilled: true,
      message: "Order ini sudah berhasil diproses.",
      orderId: order.id,
      orderNumber: order.orderNumber,
      voucherCode: order.voucher?.code,
    });
  }

  if (order.status !== "PAID" && order.status !== "FULFILLING") {
    return reply.code(409).send({
      error: `Order tidak dapat diproses ulang. Status: ${order.status}`,
    });
  }

  const paidPayment = order.payments.some(
    (payment) => payment.status === "PAID",
  );

  if (!paidPayment) {
    return reply.code(409).send({
      error: "Pembayaran order belum berstatus PAID.",
    });
  }

  if (!order.voucher || order.voucher.status !== "RESERVED") {
    return reply.code(409).send({
      error: "Voucher tidak ditemukan atau status reservasinya sudah berubah.",
    });
  }

  try {
    const result = await fulfillOrder(order.id);

    return reply.send({
      ok: true,
      message: "Provisioning voucher berhasil.",
      orderId: order.id,
      orderNumber: order.orderNumber,
      voucherCode: result.order.voucher?.code ?? result.voucher?.code,
      package: order.package.code,
    });
  } catch (error) {
    request.log.error(error);

    return reply.code(202).send({
      ok: false,
      fulfillmentPending: true,
      message: "Provisioning belum berhasil. Silakan coba ulang.",
      orderId: order.id,
      orderNumber: order.orderNumber,
    });
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

  // Detail order publik dengan field terbatas (Disertai Auto-Check Midtrans Fallback).
  app.get<{ Params: { id: string } }>(
    "/api/orders/:id",
    async (request, reply) => {
      const identifier = request.params.id;

      const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          identifier
        );

      const foundOrder = await prisma.order.findFirst({
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
              id: true,
              provider: true,
              status: true,
              method: true,
              amount: true,
              paidAt: true,
            },
          },
        },
      });

      if (!foundOrder) {
  return reply.code(404).send({
    error: "Order tidak ditemukan",
  });
}

const targetOrderId = foundOrder.id;
let order = foundOrder;

      // FALLBACK AUTO-CHECK: Verifikasi status melalui Midtrans Status API.
      if (order.status === "PENDING" && env.MIDTRANS_SERVER_KEY) {
        try {
          const authHeader = `Basic ${Buffer.from(
            env.MIDTRANS_SERVER_KEY + ":",
          ).toString("base64")}`;

          const statusBaseUrl = env.MIDTRANS_IS_PRODUCTION
            ? "https://api.midtrans.com"
            : "https://api.sandbox.midtrans.com";

          const midtransStatusUrl =
            `${statusBaseUrl}/v2/${encodeURIComponent(order.orderNumber)}/status`;

          const res = await fetch(midtransStatusUrl, {
            method: "GET",
            headers: {
              Accept: "application/json",
              Authorization: authHeader,
            },
          });

          if (res.ok) {
            const midtransData = (await res.json()) as Record<string, any>;

            const verifiedOrderId = String(midtransData.order_id ?? "");
            const statusCode = String(midtransData.status_code ?? "");
            const grossAmount = String(midtransData.gross_amount ?? "");
            const transactionStatus = String(
              midtransData.transaction_status ?? "",
            );
            const fraudStatus = String(midtransData.fraud_status ?? "");
            const transactionId = String(
              midtransData.transaction_id ?? "",
            );

            const parsedAmount = Number(grossAmount);

            const validTransaction =
              verifiedOrderId === order.orderNumber &&
              statusCode === "200" &&
              /^\d+(\.\d{1,2})?$/.test(grossAmount) &&
              Number.isFinite(parsedAmount) &&
              parsedAmount === Number(order.amount) &&
              transactionId.length > 0;

            if (!validTransaction) {
              request.log.warn(
                {
                  orderId: order.orderNumber,
                  verifiedOrderId,
                  statusCode,
                  grossAmount,
                  orderAmount: Number(order.amount),
                },
                "Data Status API Midtrans tidak cocok dengan order.",
              );
            } else {
              const midtransPayments = order.payments.filter(
                (p) => p.provider === "MIDTRANS",
              );

              if (midtransPayments.length !== 1) {
                request.log.warn(
                  {
                    orderId: order.orderNumber,
                    midtransPaymentCount: midtransPayments.length,
                  },
                  "Payment Midtrans tidak ditemukan atau tidak unik.",
                );
              } else {
                const pendingPayment = midtransPayments[0];

                if (
                  pendingPayment.status !== "PENDING" ||
                  pendingPayment.amount !== order.amount
                ) {
                  request.log.warn(
                    {
                      orderId: order.orderNumber,
                      paymentStatus: pendingPayment.status,
                      paymentAmount: pendingPayment.amount,
                      orderAmount: order.amount,
                    },
                    "Payment tidak memenuhi syarat auto-check.",
                  );
                } else {
                  const isPaid =
                    transactionStatus === "settlement" ||
                    (transactionStatus === "capture" &&
                      fraudStatus === "accept");

                  if (isPaid) {
                    const now = new Date();

                    const claimed = await prisma.$transaction(
                      async (tx) => {
                        const paymentUpdate = await tx.payment.updateMany({
                          where: {
                            id: pendingPayment.id,
                            provider: "MIDTRANS",
                            status: "PENDING",
                            amount: order.amount,
                          },
                          data: {
                            status: "PAID",
                            paidAt: now,
                            providerTransactionId: transactionId,
                            rawResponse: midtransData,
                          },
                        });

                        if (paymentUpdate.count !== 1) {
                          return false;
                        }

                        const orderUpdate = await tx.order.updateMany({
                          where: {
                            id: targetOrderId,
                            status: "PENDING",
                          },
                          data: {
                            status: "PAID",
                            paidAt: now,
                          },
                        });

                        if (orderUpdate.count !== 1) {
                          throw new Error(
                            "Order tidak lagi berstatus PENDING. Transaksi dibatalkan.",
                          );
                        }

                        return true;
                      },
                    );

                    if (claimed) {
                      await fulfillOrder(targetOrderId);

                      // Ambil ulang order beserta voucher dan payment.
                      const updatedOrder = await prisma.order.findUnique({
                        where: { id: targetOrderId },
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
                              id: true,
                              provider: true,
                              status: true,
                              method: true,
                              amount: true,
                              paidAt: true,
                            },
                          },
                        },
                      });

                      if (updatedOrder) {
                        order = updatedOrder;
                      }
                    }
                  }
                }
              }
            }
          }
        } catch (err) {
          request.log.error(err, "Gagal auto-check status Midtrans");
        }
      }

      const { voucher, ...safeOrder } = order;

      return reply.send({
        ...safeOrder,
        voucher: order.status === "FULFILLED" ? voucher : null,
      });
    }
  );
}