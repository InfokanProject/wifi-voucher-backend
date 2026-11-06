import { createHmac, timingSafeEqual } from "node:crypto";
import { FastifyInstance } from "fastify";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { fulfillOrder } from "../../services/fulfillment.service";
import {
  createMikrotikUser,
  getMikrotikUser,
  simulateMikrotikActivation,
} from "../../services/mikrotik.service";
import { getMikrotikProfile } from "../../services/mikrotik-profile";

function getSnapUrl(): string {
  return env.MIDTRANS_IS_PRODUCTION
    ? "https://app.midtrans.com/snap/v1/transactions"
    : "https://app.sandbox.midtrans.com/snap/v1/transactions";
}

export async function paymentRoutes(app: FastifyInstance) {
  // Gateway yang dipakai frontend. Hanya mengembalikan nama, tanpa data lain.
  app.get("/api/payments/active-gateway", async () => ({
    gateway: env.ACTIVE_PAYMENT_GATEWAY,
  }));

  // 1. Membuat transaksi Midtrans Snap
  // HTTP call ke Midtrans dilakukan DI LUAR transaksi database.
  app.post<{
    Params: { orderId: string };
    Body: { email?: string };
  }>("/api/payments/midtrans/:orderId/create", async (request, reply) => {
    if (!env.MIDTRANS_SERVER_KEY) {
      return reply.code(503).send({
        error: "Konfigurasi Midtrans Server Key belum diisi pada .env.",
      });
    }

    const email =
      typeof request.body?.email === "string"
        ? request.body.email.trim()
        : "";

    if (
      email.length > 255 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return reply.code(400).send({
        error: "Alamat email tidak valid.",
      });
    }

    const { orderId } = request.params;

    type MidtransPhase1 =
      | {
          kind: "reuse";
          order: { id: string; orderNumber: string; amount: number };
          redirectUrl: string;
          token: string | null;
        }
      | {
          kind: "fetch";
          order: {
            id: string;
            orderNumber: string;
            amount: number;
            customerIdentifier: string | null;
            package: { code: string; name: string };
          };
          paymentId: string;
        };

    // FASE 1: transaksi singkat dengan lock, tanpa HTTP call.
    let phase1: MidtransPhase1;

    try {
      phase1 = await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            WITH lock_result AS MATERIALIZED (
              SELECT pg_advisory_xact_lock(hashtext(${orderId}))
            )
            SELECT 1::int AS locked FROM lock_result
          `;

          const currentOrder = await tx.order.findUnique({
            where: { id: orderId },
            include: { package: true },
          });

          if (!currentOrder) {
            throw new Error("ORDER_NOT_FOUND");
          }

          if (
            currentOrder.status !== "PENDING" ||
            (currentOrder.expiresAt !== null &&
              currentOrder.expiresAt <= new Date())
          ) {
            throw new Error("ORDER_NOT_PAYABLE");
          }

          const otherGatewayPayment = await tx.payment.findFirst({
            where: {
              orderId: currentOrder.id,
              provider: "WAROENGPAY",
              status: "PENDING",
            },
            select: { id: true },
          });

          if (otherGatewayPayment) {
            throw new Error("OTHER_GATEWAY_PAYMENT_PENDING");
          }

          const existing = await tx.payment.findFirst({
            where: {
              orderId: currentOrder.id,
              provider: "MIDTRANS",
              status: "PENDING",
            },
            orderBy: { createdAt: "desc" },
          });

          if (existing) {
            const saved =
              existing.rawResponse &&
              typeof existing.rawResponse === "object" &&
              !Array.isArray(existing.rawResponse)
                ? (existing.rawResponse as Record<string, unknown>)
                : null;

            if (saved && typeof saved.redirectUrl === "string") {
              return {
                kind: "reuse",
                order: {
                  id: currentOrder.id,
                  orderNumber: currentOrder.orderNumber,
                  amount: currentOrder.amount,
                },
                redirectUrl: saved.redirectUrl,
                token: typeof saved.token === "string" ? saved.token : null,
              } as MidtransPhase1;
            }
          }

          const paymentId =
            existing?.id ??
            (
              await tx.payment.create({
                data: {
                  orderId: currentOrder.id,
                  provider: "MIDTRANS",
                  method: "QRIS",
                  amount: currentOrder.amount,
                  status: "PENDING",
                },
              })
            ).id;

          return {
            kind: "fetch",
            order: {
              id: currentOrder.id,
              orderNumber: currentOrder.orderNumber,
              amount: currentOrder.amount,
              customerIdentifier: currentOrder.customerIdentifier,
              package: {
                code: currentOrder.package.code,
                name: currentOrder.package.name,
              },
            },
            paymentId,
          } as MidtransPhase1;
        },
        { maxWait: 10000, timeout: 15000 },
      );
    } catch (err) {
      request.log.error({ err, orderId }, "Gagal menyiapkan pembayaran Midtrans.");

      if (err instanceof Error) {
        if (err.message === "ORDER_NOT_FOUND") {
          return reply.code(404).send({ error: "Order tidak ditemukan." });
        }

        if (err.message === "ORDER_NOT_PAYABLE") {
          return reply.code(409).send({
            error: "Order tidak lagi bisa dibayar.",
          });
        }

        if (err.message === "OTHER_GATEWAY_PAYMENT_PENDING") {
          return reply.code(409).send({
            error: "Order sudah memiliki invoice aktif dari gateway lain.",
          });
        }
      }

      return reply.code(502).send({
        error: "Gagal membuat transaksi Midtrans.",
      });
    }

    if (phase1.kind === "reuse") {
      return reply.send({
        orderId: phase1.order.id,
        orderNumber: phase1.order.orderNumber,
        amount: phase1.order.amount,
        redirectUrl: phase1.redirectUrl,
        token: phase1.token,
      });
    }

    // FASE 2: panggil Midtrans Snap di luar transaksi.
    let snapToken: string;
    let snapRedirectUrl: string;

    try {
      const authHeader = `Basic ${Buffer.from(
        env.MIDTRANS_SERVER_KEY + ":",
      ).toString("base64")}`;

      const response = await fetch(getSnapUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: authHeader,
          "X-Override-Notification": `${env.PUBLIC_APP_URL}/api/payments/midtrans/notification`,
        },
        body: JSON.stringify({
          transaction_details: {
            order_id: phase1.order.orderNumber,
            gross_amount: phase1.order.amount,
          },
          callbacks: {
            finish: `${env.PUBLIC_APP_URL}/beli`,
          },
          item_details: [
            {
              id: phase1.order.package.code,
              price: phase1.order.amount,
              quantity: 1,
              name: `Voucher WiFi ${phase1.order.package.name}`,
            },
          ],
          customer_details: {
            email,
            phone: phase1.order.customerIdentifier || "",
          },
        }),
        signal: AbortSignal.timeout(15000),
      });

      const result = (await response.json()) as {
        token?: string;
        redirect_url?: string;
        error_messages?: string[];
      };

      if (
        !response.ok ||
        typeof result.token !== "string" ||
        typeof result.redirect_url !== "string"
      ) {
        request.log.warn(
          {
            orderNumber: phase1.order.orderNumber,
            httpStatus: response.status,
            errors: result.error_messages,
          },
          "Midtrans menolak pembuatan transaksi Snap",
        );

        return reply.code(502).send({
          error: "Gagal membuat transaksi Midtrans.",
        });
      }

      snapToken = result.token;
      snapRedirectUrl = result.redirect_url;
    } catch (err) {
      request.log.error(
        { err, orderId },
        "Request pembuatan transaksi Snap Midtrans gagal.",
      );

      return reply.code(502).send({
        error: "Gagal membuat transaksi Midtrans.",
      });
    }

    // FASE 3: simpan token dan redirectUrl dalam update singkat.
    try {
      const saved = await prisma.payment.updateMany({
        where: { id: phase1.paymentId, status: "PENDING" },
        data: {
          rawResponse: {
            token: snapToken,
            redirectUrl: snapRedirectUrl,
          },
        },
      });

      if (saved.count !== 1) {
        request.log.error(
          { orderId, paymentId: phase1.paymentId },
          "Payment tidak lagi PENDING saat menyimpan transaksi Snap.",
        );

        return reply.code(409).send({
          error: "Order tidak lagi bisa dibayar.",
        });
      }
    } catch (err) {
      request.log.error(
        { err, orderId },
        "Gagal menyimpan transaksi Snap Midtrans.",
      );

      return reply.code(502).send({
        error: "Gagal menyimpan transaksi. Silakan coba lagi.",
      });
    }

    return reply.send({
      orderId: phase1.order.id,
      orderNumber: phase1.order.orderNumber,
      amount: phase1.order.amount,
      redirectUrl: snapRedirectUrl,
      token: snapToken,
    });
  });

  // 2. Notification Webhook Midtrans
  app.post("/api/payments/midtrans/notification", async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;

    if (!body || typeof body !== "object") {
      return reply.code(200).send({ status: "OK", message: "Payload kosong." });
    }

    const orderId = String(body.order_id ?? "");

if (!orderId) {
  return reply.code(200).send({
    status: "OK",
    message: "Order ID tidak ditemukan.",
  });
}

// Cari order lokal terlebih dahulu.
const order = await prisma.order.findUnique({
  where: { orderNumber: orderId },
  include: {
    package: true,
    payments: true,
    voucher: true,
  },
});

if (!order) {
  request.log.warn(
    { orderId },
    "Order notifikasi Midtrans tidak ditemukan.",
  );

  return reply.send({
    status: "OK",
    message: "Order dummy/test diterima.",
  });
}

// Webhook hanya menjadi pemicu.
// Status pembayaran diverifikasi langsung melalui Midtrans API.
const statusBaseUrl = env.MIDTRANS_IS_PRODUCTION
  ? "https://api.midtrans.com"
  : "https://api.sandbox.midtrans.com";

const statusUrl =
  `${statusBaseUrl}/v2/${encodeURIComponent(order.orderNumber)}/status`;

let midtransData: Record<string, any>;

try {
  const authHeader = `Basic ${Buffer.from(
    env.MIDTRANS_SERVER_KEY + ":",
  ).toString("base64")}`;

  const statusResponse = await fetch(statusUrl, {
    signal: AbortSignal.timeout(10000),
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: authHeader,
    },
  });

  if (!statusResponse.ok) {
    const responseText = await statusResponse.text();

    request.log.error(
      {
        orderId,
        httpStatus: statusResponse.status,
        response: responseText,
      },
      "Gagal mengambil status transaksi dari Midtrans.",
    );

    return reply.code(503).send({
      status: "ERROR",
      message: "Status pembayaran belum dapat diverifikasi.",
    });
  }

  midtransData = (await statusResponse.json()) as Record<string, any>;
} catch (err) {
  request.log.error(
    { err, orderId },
    "Request GET Status API Midtrans gagal.",
  );

  return reply.code(503).send({
    status: "ERROR",
    message: "Tidak dapat menghubungi Midtrans.",
  });
}

// Ambil data pembayaran dari respons API yang sudah diautentikasi.
const verifiedOrderId = String(midtransData.order_id ?? "");
const statusCode = String(midtransData.status_code ?? "");
const grossAmount = String(midtransData.gross_amount ?? "");
const transactionStatus = String(
  midtransData.transaction_status ?? "",
);
const fraudStatus = String(midtransData.fraud_status ?? "");
const transactionId = String(midtransData.transaction_id ?? "");

// Validasi identitas order dan nominal.
const parsedAmount = Number(grossAmount);

if (
  verifiedOrderId !== order.orderNumber ||
  statusCode !== "200" ||
  !/^\d+(\.\d{1,2})?$/.test(grossAmount) ||
  !Number.isFinite(parsedAmount) ||
  parsedAmount !== Number(order.amount)
) {
  request.log.error(
    {
      orderId,
      verifiedOrderId,
      statusCode,
      grossAmount,
      orderAmount: Number(order.amount),
    },
    "Respons GET Status API Midtrans tidak cocok dengan order lokal.",
  );

  return reply.code(502).send({
    status: "ERROR",
    message: "Data transaksi Midtrans tidak cocok dengan order.",
  });
}

const recordMidtransAnomaly = async (
  action: string,
  description: string,
  metadata: Record<string, unknown>,
) => {
  const success =
    transactionStatus === "settlement" ||
    (transactionStatus === "capture" && fraudStatus === "accept");
  if (!success || !transactionId) return;
  try {
    const existing = await prisma.auditLog.findFirst({
      where: {
        action,
        entityType: "Order",
        entityId: order.id,
        metadata: { path: ["transactionId"], equals: transactionId },
      },
      select: { id: true },
    });
    if (existing) return;
    await prisma.auditLog.create({
      data: {
        action,
        entityType: "Order",
        entityId: order.id,
        description,
        metadata: { transactionId, orderNumber: order.orderNumber, ...metadata } as any,
      },
    });
  } catch (auditError) {
    request.log.error(
      { err: auditError, orderId },
      "Gagal mencatat audit log anomali Midtrans.",
    );
  }
};

// Pastikan hanya ada satu payment Midtrans.
const midtransPayments = order.payments.filter(
  (p) => p.provider === "MIDTRANS",
);

if (midtransPayments.length !== 1) {
  request.log.error(
    {
      orderId,
      midtransPaymentCount: midtransPayments.length,
    },
    "Jumlah payment Midtrans tidak sesuai.",
  );
  await recordMidtransAnomaly(
    "WEBHOOK_PAYMENT_NOT_UNIQUE",
    `Jumlah payment Midtrans untuk order ${order.orderNumber} tidak tepat satu.`,
    { midtransPaymentCount: midtransPayments.length },
  );

  return reply.send({
    status: "OK",
    message: "Payment Midtrans tidak ditemukan atau tidak unik.",
  });
}

const payment = midtransPayments[0];
if (payment.amount !== order.amount) {
  request.log.error(
    {
      orderId,
      paymentAmount: payment.amount,
      orderAmount: order.amount,
    },
    "Nominal payment Midtrans tidak cocok dengan order.",
  );
  await recordMidtransAnomaly(
    "WEBHOOK_PAYMENT_AMOUNT_MISMATCH",
    `Nominal payment Midtrans tidak cocok dengan order ${order.orderNumber}.`,
    { paymentAmount: payment.amount, orderAmount: order.amount },
  );

  return reply.send({
    status: "OK",
    message: "Nominal payment tidak cocok.",
  });
}

const verifiedRawResponse = {
  webhook: body,
  status: midtransData,
};

const isSuccess =
  transactionStatus === "settlement" ||
  (transactionStatus === "capture" && fraudStatus === "accept");

const isFailedOrExpired =
  transactionStatus === "deny" ||
  transactionStatus === "cancel" ||
  transactionStatus === "expire";

const now = new Date();
    
if (isSuccess) {
  // Order sudah selesai: jangan pernah menerbitkan voucher ulang.
    // Order sudah selesai: jangan pernah menerbitkan voucher ulang.
  if (order.status === "FULFILLED") {
    if (order.winningPaymentId !== payment.id) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: "PAID",
          paidAt: payment.paidAt ?? now,
          providerTransactionId:
            transactionId || payment.providerTransactionId,
          rawResponse: verifiedRawResponse as any,
        },
      });

      if (payment.status !== "PAID") {
        await prisma.auditLog.create({
          data: {
            action: "LATE_PAYMENT_RECONCILIATION_REQUIRED",
            entityType: "Order",
            entityId: order.id,
            description: `Pembayaran Midtrans bukan pemenang untuk order ${order.orderNumber}.`,
            metadata: {
              orderNumber: order.orderNumber,
              amount: order.amount,
              transactionId,
              winningPaymentId: order.winningPaymentId,
              paymentId: payment.id,
            },
          },
        });
      }

      return reply.send({
        status: "OK",
        message: "Pembayaran tambahan dicatat untuk rekonsiliasi.",
      });
    }

    if (!payment.providerTransactionId && transactionId) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          providerTransactionId: transactionId,
          rawResponse: verifiedRawResponse as any,
        },
      });
    }

    return reply.send({
      status: "OK",
      message: "Order sudah diproses sebelumnya.",
    });
  }

  // Pemulihan fulfillment hanya boleh dilakukan oleh payment pemenang.
  if (
    order.status === "PAID" ||
    order.status === "FULFILLING"
  ) {
    if (order.winningPaymentId !== payment.id) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: "PAID",
          paidAt: payment.paidAt ?? now,
          providerTransactionId:
            transactionId || payment.providerTransactionId,
          rawResponse: verifiedRawResponse as any,
        },
      });

      if (payment.status !== "PAID") {
        await prisma.auditLog.create({
          data: {
            action: "LATE_PAYMENT_RECONCILIATION_REQUIRED",
            entityType: "Order",
            entityId: order.id,
            description: `Pembayaran Midtrans bukan pemenang untuk order ${order.orderNumber}.`,
            metadata: {
              orderNumber: order.orderNumber,
              amount: order.amount,
              transactionId,
              winningPaymentId: order.winningPaymentId,
              paymentId: payment.id,
            },
          },
        });
      }

      return reply.send({
        status: "OK",
        message: "Pembayaran tambahan dicatat untuk rekonsiliasi.",
      });
    }

    try {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: "PAID",
          paidAt: payment.paidAt ?? now,
          providerTransactionId:
            transactionId || payment.providerTransactionId,
          rawResponse: verifiedRawResponse as any,
        },
      });

      const result = await fulfillOrder(order.id);

      return reply.send({
        status: "OK",
        message: result.alreadyFulfilled
          ? "Order sudah diproses sebelumnya."
          : "Fulfillment berhasil dipulihkan.",
      });
    } catch (err) {
      request.log.error(
        { err, orderId },
        "Pemulihan fulfillment Midtrans gagal.",
      );

      return reply.code(500).send({
        status: "ERROR",
        message: "Fulfillment belum selesai. Silakan kirim ulang notifikasi.",
      });
    }
  }

  // Pembayaran terlambat setelah order kedaluwarsa.
  if (order.expiresAt && order.expiresAt <= now) {
    request.log.warn(
      { orderNumber: order.orderNumber, transactionId },
      "Pembayaran Midtrans diterima setelah order kedaluwarsa (LATE PAYMENT).",
    );

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: "PAID",
        paidAt: now,
        providerTransactionId: transactionId,
rawResponse: verifiedRawResponse as any,      },
    });

    await prisma.auditLog.create({
      data: {
        action: "LATE_PAYMENT_RECONCILIATION_REQUIRED",
        entityType: "Order",
        entityId: order.id,
        description: `Pembayaran Midtrans diterima setelah order ${order.orderNumber} kedaluwarsa.`,
        metadata: {
          orderNumber: order.orderNumber,
          amount: order.amount,
          transactionId,
          transactionStatus,
        },
      },
    });

    return reply.send({
      status: "OK",
      message: "Late payment dicatat untuk rekonsiliasi.",
    });
  }

  try {
        await prisma.$transaction(async (tx) => {
      // Klaim order terlebih dahulu. Hanya satu payment dari
      // seluruh provider yang boleh menjadi pemenang.
      const claimed = await tx.order.updateMany({
        where: {
          id: order.id,
          status: "PENDING",
          winningPaymentId: null,
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: now } },
          ],
        },
        data: {
          status: "PAID",
          paidAt: now,
          winningPaymentId: payment.id,
        },
      });

      if (claimed.count !== 1) {
        throw new Error("ORDER_ALREADY_PROCESSED");
      }

      const paymentUpdated = await tx.payment.updateMany({
        where: {
          id: payment.id,
          orderId: order.id,
          provider: "MIDTRANS",
          status: "PENDING",
          amount: order.amount,
        },
        data: {
          status: "PAID",
          paidAt: now,
          providerTransactionId: transactionId,
          rawResponse: verifiedRawResponse as any,
        },
      });

      if (paymentUpdated.count !== 1) {
        throw new Error("PAYMENT_UPDATE_FAILED_AFTER_ORDER_CLAIM");
      }
    });



    await fulfillOrder(order.id);

    return reply.send({
      status: "OK",
      message: "Pembayaran dan fulfillment berhasil.",
    });
  } catch (err) {
    request.log.error(
      { err, orderId },
      "Gagal memproses fulfillment dari webhook Midtrans.",
    );

    return reply.code(500).send({
      status: "ERROR",
      message: "Pembayaran tercatat atau sedang diproses, tetapi fulfillment belum selesai.",
    });
  }
}


        if (isFailedOrExpired) {
      const updated = await prisma.payment.updateMany({
        where: {
          id: payment.id,
          status: "PENDING",
        },
        data: {
          status: transactionStatus === "expire" ? "EXPIRED" : "FAILED",
          providerTransactionId:
            transactionId || payment.providerTransactionId,
rawResponse: verifiedRawResponse as any,        },
      });

      if (updated.count === 0) {
        request.log.info(
          { orderId, paymentId: payment.id, currentStatus: payment.status },
          "Notifikasi gagal diabaikan karena payment sudah tidak PENDING.",
        );
      }

      return reply.send({
        status: "OK",
        message: `Transaksi berstatus ${transactionStatus}.`,
      });
    }

    return reply.send({ status: "OK", message: "Notifikasi diterima." });
  });

  // 3. Membuat invoice WaroengPay QRIS
  // HTTP call ke WaroengPay dilakukan DI LUAR transaksi database.
  app.post<{
    Params: { orderId: string };
  }>("/api/payments/waroengpay/:orderId/create", async (request, reply) => {
    if (
      !env.WAROENGPAY_API_KEY ||
      !env.WAROENGPAY_API_KEY.startsWith("wp_test_")
    ) {
      return reply.code(503).send({
        error: "Konfigurasi WaroengPay Sandbox belum tersedia.",
      });
    }

    if (!env.PUBLIC_APP_URL) {
      return reply.code(503).send({
        error: "PUBLIC_APP_URL belum dikonfigurasi.",
      });
    }

    const { orderId } = request.params;

    // Masa tenggang WaroengPay 5 menit + batas minimal expires_in 5 menit.
    const MIN_REMAINING_MS = 10 * 60 * 1000;
    const MIN_REUSE_MS = 2 * 60 * 1000;

    type Phase1 =
      | {
          kind: "reuse";
          order: { id: string; orderNumber: string };
          invoiceId: string;
          amount: number;
          payUrl: string;
          qris: unknown;
          expiresAt: unknown;
        }
      | {
          kind: "fetch";
          order: {
            id: string;
            orderNumber: string;
            amount: number;
            package: { name: string };
          };
          paymentId: string;
          expiresIn: number;
        };

    // FASE 1: transaksi singkat dengan lock, tanpa HTTP call.
    let phase1: Phase1;

    try {
      phase1 = await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            WITH lock_result AS MATERIALIZED (
              SELECT pg_advisory_xact_lock(hashtext(${orderId}))
            )
            SELECT 1::int AS locked FROM lock_result
          `;

          const currentOrder = await tx.order.findUnique({
            where: { id: orderId },
            include: { package: true },
          });

          if (!currentOrder) {
            throw new Error("ORDER_NOT_FOUND");
          }

          const now = new Date();

          if (
            currentOrder.status !== "PENDING" ||
            (currentOrder.expiresAt !== null &&
              currentOrder.expiresAt <= now)
          ) {
            throw new Error("ORDER_NOT_PAYABLE");
          }

          if (
            currentOrder.expiresAt &&
            currentOrder.expiresAt.getTime() - now.getTime() <
              MIN_REMAINING_MS
          ) {
            throw new Error("ORDER_EXPIRING_SOON");
          }

          const otherGatewayPayment = await tx.payment.findFirst({
            where: {
              orderId: currentOrder.id,
              provider: "MIDTRANS",
              status: "PENDING",
            },
            select: { id: true },
          });

          if (otherGatewayPayment) {
            throw new Error("OTHER_GATEWAY_PAYMENT_PENDING");
          }

          const existing = await tx.payment.findFirst({
            where: {
              orderId: currentOrder.id,
              provider: "WAROENGPAY",
              status: "PENDING",
            },
            orderBy: { createdAt: "desc" },
          });

          let reusablePaymentId: string | null = null;

          if (existing) {
            if (!existing.providerTransactionId) {
              // Belum punya invoice: pakai lagi dengan Idempotency-Key sama.
              reusablePaymentId = existing.id;
            } else {
              const saved =
                existing.rawResponse &&
                typeof existing.rawResponse === "object" &&
                !Array.isArray(existing.rawResponse)
                  ? (existing.rawResponse as Record<string, unknown>)
                  : null;

              const invoiceExpiresMs =
                saved && typeof saved.expires_at === "string"
                  ? Date.parse(saved.expires_at)
                  : NaN;

              if (
                saved &&
                typeof saved.pay_url === "string" &&
                Number.isFinite(invoiceExpiresMs) &&
                invoiceExpiresMs - now.getTime() > MIN_REUSE_MS
              ) {
                return {
                  kind: "reuse",
                  order: {
                    id: currentOrder.id,
                    orderNumber: currentOrder.orderNumber,
                  },
                  invoiceId: existing.providerTransactionId,
                  amount: existing.amount,
                  payUrl: saved.pay_url,
                  qris: saved.qris ?? null,
                  expiresAt: saved.expires_at ?? null,
                } as Phase1;
              }

              // Invoice hampir/sudah kedaluwarsa: tutup secara lokal.
              // Jika masih dibayar di masa tenggang, webhook tetap bisa
              // memproses karena klaim pemenang tidak bergantung status ini.
              await tx.payment.updateMany({
                where: { id: existing.id, status: "PENDING" },
                data: { status: "EXPIRED" },
              });
            }
          }

          const paymentId =
            reusablePaymentId ??
            (
              await tx.payment.create({
                data: {
                  orderId: currentOrder.id,
                  provider: "WAROENGPAY",
                  method: "QRIS",
                  amount: currentOrder.amount,
                  status: "PENDING",
                },
              })
            ).id;

          const expiresIn = currentOrder.expiresAt
            ? Math.min(
                60,
                Math.floor(
                  (currentOrder.expiresAt.getTime() - now.getTime()) / 60000,
                ) - 5,
              )
            : 60;

          return {
            kind: "fetch",
            order: {
              id: currentOrder.id,
              orderNumber: currentOrder.orderNumber,
              amount: currentOrder.amount,
              package: { name: currentOrder.package.name },
            },
            paymentId,
            expiresIn,
          } as Phase1;
        },
        { maxWait: 10000, timeout: 15000 },
      );
    } catch (err) {
      return handleWaroengPayCreateError(err);
    }

    if (phase1.kind === "reuse") {
      return reply.send({
        ok: true,
        orderId: phase1.order.id,
        orderNumber: phase1.order.orderNumber,
        invoiceId: phase1.invoiceId,
        amount: phase1.amount,
        payUrl: phase1.payUrl,
        qris: phase1.qris,
        expiresAt: phase1.expiresAt,
      });
    }

    // FASE 2: panggil WaroengPay di luar transaksi.
    let invoice: Record<string, unknown>;

    try {
      const response = await fetch("https://waroengpay.com/api/payments", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.WAROENGPAY_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": `${phase1.order.orderNumber}:${phase1.paymentId}`,
        },
        body: JSON.stringify({
          amount: phase1.order.amount,
          reference: phase1.order.orderNumber,
          description: `Voucher WiFi ${phase1.order.package.name}`,
          callback_url: `${env.PUBLIC_APP_URL}/api/payments/waroengpay/webhook`,
          redirect_url: `${env.PUBLIC_APP_URL}/beli`,
          expires_in: phase1.expiresIn,
        }),
        signal: AbortSignal.timeout(15000),
      });

      invoice = (await response.json()) as Record<string, unknown>;

      if (
        !response.ok ||
        typeof invoice.id !== "string" ||
        typeof invoice.base_amount !== "number" ||
        typeof invoice.amount !== "number" ||
        typeof invoice.pay_url !== "string" ||
        invoice.base_amount !== phase1.order.amount ||
        !Number.isInteger(invoice.amount) ||
        invoice.amount < invoice.base_amount ||
        invoice.livemode !== false
      ) {
        request.log.error(
          {
            orderNumber: phase1.order.orderNumber,
            httpStatus: response.status,
            response: invoice,
          },
          "WaroengPay menolak pembuatan invoice atau respons tidak valid.",
        );

        return reply.code(502).send({
          error: "Gagal membuat invoice WaroengPay.",
        });
      }
    } catch (err) {
      request.log.error(
        { err, orderId },
        "Request pembuatan invoice WaroengPay gagal.",
      );

      return reply.code(502).send({
        error: "Gagal membuat invoice WaroengPay.",
      });
    }

    // FASE 3: simpan hasil invoice dalam update singkat.
    try {
      const saved = await prisma.payment.updateMany({
        where: { id: phase1.paymentId, status: "PENDING" },
        data: {
          amount: invoice.amount as number,
          providerTransactionId: invoice.id as string,
          rawResponse: invoice as any,
        },
      });

      if (saved.count !== 1) {
        request.log.error(
          { orderId, paymentId: phase1.paymentId },
          "Payment tidak lagi PENDING saat menyimpan invoice WaroengPay.",
        );

        return reply.code(409).send({
          error: "Order tidak lagi bisa dibayar.",
        });
      }
    } catch (err) {
      request.log.error(
        { err, orderId, invoiceId: invoice.id },
        "Gagal menyimpan invoice WaroengPay. Retry akan memakai Idempotency-Key yang sama.",
      );

      return reply.code(502).send({
        error: "Gagal menyimpan invoice. Silakan coba lagi.",
      });
    }

    return reply.send({
      ok: true,
      orderId: phase1.order.id,
      orderNumber: phase1.order.orderNumber,
      invoiceId: invoice.id,
      amount: invoice.amount,
      payUrl: invoice.pay_url,
      qris: invoice.qris ?? null,
      expiresAt: invoice.expires_at ?? null,
    });

    function handleWaroengPayCreateError(err: unknown) {
      request.log.error({ err, orderId }, "Gagal membuat invoice WaroengPay.");

      if (err instanceof Error) {
        if (err.message === "ORDER_NOT_FOUND") {
          return reply.code(404).send({ error: "Order tidak ditemukan." });
        }

        if (
          err.message === "ORDER_NOT_PAYABLE" ||
          err.message === "ORDER_EXPIRING_SOON"
        ) {
          return reply.code(409).send({
            error: "Order tidak lagi bisa dibayar. Buat order baru.",
          });
        }

        if (err.message === "OTHER_GATEWAY_PAYMENT_PENDING") {
          return reply.code(409).send({
            error: "Order sudah memiliki invoice aktif dari gateway lain.",
          });
        }
      }

      return reply.code(502).send({
        error: "Gagal membuat invoice WaroengPay.",
      });
    }
  });

   // Webhook WaroengPay
  app.post(
    "/api/payments/waroengpay/webhook",
    {
      config: {
        rawBody: true,
      },
    },
    async (request, reply) => {
      if (!env.WAROENGPAY_WEBHOOK_SECRET) {
        request.log.error("WaroengPay webhook secret belum dikonfigurasi.");
        return reply.code(503).send({ error: "Webhook belum dikonfigurasi." });
      }

      const getHeader = (name: string): string => {
        const value = request.headers[name.toLowerCase()];
        return Array.isArray(value) ? value[0] ?? "" : value ?? "";
      };

      const eventHeader = getHeader("x-waroengpay-event");
      const timestampHeader = getHeader("x-waroengpay-timestamp");
      const signatureHeader = getHeader("x-signature");

      const rawBody = Buffer.isBuffer(request.rawBody)
        ? request.rawBody.toString("utf8")
        : request.rawBody;

      if (
        typeof rawBody !== "string" ||
        !eventHeader ||
        !timestampHeader ||
        !signatureHeader
      ) {
        return reply.code(400).send({
          error: "Header atau raw body webhook tidak lengkap.",
        });
      }

      // Timestamp WaroengPay menggunakan Unix timestamp dalam detik.
      const timestamp = Number(timestampHeader);

      if (
        !Number.isSafeInteger(timestamp) ||
        Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300
      ) {
        return reply.code(401).send({
          error: "Timestamp webhook tidak valid atau sudah kedaluwarsa.",
        });
      }

      // Verifikasi HMAC-SHA256 menggunakan raw body asli.
      const expectedSignature = createHmac(
        "sha256",
        env.WAROENGPAY_WEBHOOK_SECRET,
      )
        .update(`${timestampHeader}.${rawBody}`)
        .digest();

      const suppliedHex = signatureHeader.replace(/^sha256=/i, "").trim();

      if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) {
        return reply.code(401).send({
          error: "Format signature tidak valid.",
        });
      }

      const suppliedSignature = Buffer.from(suppliedHex, "hex");

      if (
        suppliedSignature.length !== expectedSignature.length ||
        !timingSafeEqual(suppliedSignature, expectedSignature)
      ) {
        request.log.warn("Signature webhook WaroengPay tidak cocok.");

        return reply.code(401).send({
          error: "Signature tidak valid.",
        });
      }

      const body = request.body as Record<string, any> | null;

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return reply.code(400).send({
          error: "Payload webhook tidak valid.",
        });
      }

      if (body.event !== eventHeader) {
        return reply.code(400).send({
          error: "Event header dan payload tidak cocok.",
        });
      }

      // Sandbox harus menerima livemode=false.
      // Sebaliknya, kredensial Live hanya menerima livemode=true.
      const isSandbox = env.WAROENGPAY_API_KEY.startsWith("wp_test_");

      if (body.livemode !== !isSandbox) {
        request.log.warn(
          {
            event: body.event,
            livemode: body.livemode,
            isSandbox,
          },
          "Webhook WaroengPay diabaikan karena mode tidak cocok.",
        );

        return reply.send({
          status: "OK",
          message: "Mode transaksi tidak cocok.",
        });
      }

      // Ping hanya digunakan untuk menguji konektivitas webhook.
      if (body.event === "ping") {
        return reply.send({
          status: "OK",
          message: "Pong.",
        });
      }

      const eventId =
        typeof body.id === "string" ? body.id.trim() : "";

      if (
        !eventId ||
        eventId.length > 160 ||
        !["payment.paid", "payment.expired", "payment.cancelled"].includes(
          body.event,
        )
      ) {
        return reply.code(400).send({
          error: "Identitas atau tipe event tidak valid.",
        });
      }

      const data = body.data as Record<string, any> | null;

      if (
        !data ||
        typeof data !== "object" ||
        typeof data.id !== "string" ||
        !Number.isInteger(data.base_amount) ||
        !Number.isInteger(data.amount)
      ) {
        return reply.code(400).send({
          error: "Data invoice webhook tidak valid.",
        });
      }

      const recordWebhookAnomaly = async (
        action: string,
        entityType: string,
        entityId: string,
        description: string,
        metadata: Record<string, unknown>,
      ) => {
        if (body.event !== "payment.paid") return;
        try {
          const existing = await prisma.auditLog.findFirst({
            where: {
              action,
              entityType,
              entityId,
              metadata: { path: ["eventId"], equals: eventId },
            },
            select: { id: true },
          });
          if (existing) return;
          await prisma.auditLog.create({
            data: {
              action,
              entityType,
              entityId,
              description,
              metadata: { eventId, ...metadata } as any,
            },
          });
        } catch (auditError) {
          request.log.error(
            { err: auditError, eventId },
            "Gagal mencatat audit log anomali webhook.",
          );
        }
      };
      // Cari berdasarkan ID invoice WaroengPay, bukan reference.
      const payment = await prisma.payment.findFirst({
        where: {
          provider: "WAROENGPAY",
          providerTransactionId: data.id,
        },
        include: {
          order: true,
        },
      });

      if (!payment) {
        request.log.warn(
          { invoiceId: data.id, eventId },
          "Invoice WaroengPay tidak ditemukan di database.",
        );
        await recordWebhookAnomaly(
          "WEBHOOK_INVOICE_NOT_FOUND",
          "Webhook",
          data.id,
          `Webhook WaroengPay untuk invoice ${data.id} tidak punya payment lokal.`,
          { amount: data.amount, baseAmount: data.base_amount, reference: data.reference ?? null }
        );

        return reply.send({
          status: "OK",
          message: "Invoice tidak ditemukan.",
        });
      }

      // Validasi nominal dasar dan nominal akhir termasuk kode unik.
      if (
        data.base_amount !== payment.order.amount ||
        data.amount !== payment.amount
      ) {
        request.log.error(
          {
            invoiceId: data.id,
            baseAmount: data.base_amount,
            orderAmount: payment.order.amount,
            invoiceAmount: data.amount,
            paymentAmount: payment.amount,
          },
          "Nominal invoice WaroengPay tidak cocok.",
        );
        await recordWebhookAnomaly(
          "WEBHOOK_AMOUNT_MISMATCH",
          "Order",
          payment.orderId,
          `Nominal webhook WaroengPay tidak cocok untuk invoice ${data.id}.`,
          { invoiceId: data.id, baseAmount: data.base_amount, orderAmount: payment.order.amount, invoiceAmount: data.amount, paymentAmount: payment.amount }
        );

        return reply.code(400).send({
          error: "Nominal invoice tidak cocok.",
        });
      }

      const now = new Date();
      const isPaid = body.event === "payment.paid";

      let shouldFulfill = false;

      try {
        const result = await prisma.$transaction(async (tx) => {
          // Kunci order agar dua webhook tidak memenangkan order bersamaan.
          await tx.$queryRaw`
            WITH lock_result AS MATERIALIZED (
              SELECT pg_advisory_xact_lock(hashtext(${payment.orderId}))
            )
            SELECT 1::int AS locked FROM lock_result
          `;

          // Event dicatat dalam transaksi yang sama dengan perubahan payment.
          // Jika transaksi gagal, pencatatan event ikut rollback.
          await tx.webhookEvent.create({
            data: {
              provider: "WAROENGPAY",
              eventId,
              eventType: body.event,
              payload: body as any,
            },
          });

          const currentPayment = await tx.payment.findUnique({
            where: { id: payment.id },
          });

          const currentOrder = await tx.order.findUnique({
            where: { id: payment.orderId },
          });

          if (!currentPayment || !currentOrder) {
            throw new Error("PAYMENT_OR_ORDER_NOT_FOUND");
          }

          if (isPaid) {
            // Pembayaran berhasil: status payment tetap dicatat PAID,
            // termasuk jika invoice sebelumnya sudah EXPIRED atau FAILED.
            await tx.payment.update({
              where: { id: currentPayment.id },
              data: {
                status: "PAID",
                paidAt: currentPayment.paidAt ?? now,
                rawResponse: {
                  ...(currentPayment.rawResponse && typeof currentPayment.rawResponse === "object" && !Array.isArray(currentPayment.rawResponse) ? (currentPayment.rawResponse as Record<string, unknown>) : {}),
                  webhook: body,
                } as any,
              },
            });

            // Order sudah selesai dengan payment ini sebagai pemenang.
            if (
              currentOrder.status === "FULFILLED" &&
              currentOrder.winningPaymentId === currentPayment.id
            ) {
              return { fulfill: false };
            }

            // Order sudah PAID/FULFILLING oleh payment yang sama.
            // Panggil fulfillment untuk pemulihan jika diperlukan.
            if (
              (currentOrder.status === "PAID" ||
                currentOrder.status === "FULFILLING") &&
              currentOrder.winningPaymentId === currentPayment.id
            ) {
              return { fulfill: true };
            }

            // Hanya order PENDING yang belum kedaluwarsa dan belum
            // memiliki pemenang yang boleh diklaim.
            if (
              currentOrder.status === "PENDING" &&
              currentOrder.winningPaymentId === null &&
              (!currentOrder.expiresAt ||
                currentOrder.expiresAt > now)
            ) {
              const claimed = await tx.order.updateMany({
                where: {
                  id: currentOrder.id,
                  status: "PENDING",
                  winningPaymentId: null,
                  OR: [
                    { expiresAt: null },
                    { expiresAt: { gt: now } },
                  ],
                },
                data: {
                  status: "PAID",
                  paidAt: now,
                  winningPaymentId: currentPayment.id,
                },
              });

              if (claimed.count === 1) {
                return { fulfill: true };
              }
            }

            // Pembayaran terlambat atau payment lain sudah memenangkan order.
            await tx.auditLog.create({
              data: {
                action: "LATE_PAYMENT_RECONCILIATION_REQUIRED",
                entityType: "Order",
                entityId: currentOrder.id,
                description:
                  `Pembayaran WaroengPay perlu rekonsiliasi untuk order ${currentOrder.orderNumber}.`,
                metadata: {
                  orderNumber: currentOrder.orderNumber,
                  invoiceId: data.id,
                  amount: data.amount,
                  baseAmount: data.base_amount,
                  eventId,
                  late: data.late === true,
                  orderStatus: currentOrder.status,
                  winningPaymentId: currentOrder.winningPaymentId,
                  paymentId: currentPayment.id,
                },
              },
            });

            return { fulfill: false };
          }

          // Event expired/cancelled tidak boleh menurunkan status
          // payment yang sudah PAID.
          await tx.payment.updateMany({
            where: {
              id: currentPayment.id,
              status: "PENDING",
            },
            data: {
              status:
                body.event === "payment.expired" ? "EXPIRED" : "FAILED",
              rawResponse: {
                ...(currentPayment.rawResponse && typeof currentPayment.rawResponse === "object" && !Array.isArray(currentPayment.rawResponse) ? (currentPayment.rawResponse as Record<string, unknown>) : {}),
                webhook: body,
              } as any,
            },
          });

          return { fulfill: false };
        });

        shouldFulfill = result.fulfill;
      } catch (err) {
                // Event duplikat: coba pulihkan fulfillment jika payment
        // ini memang pemenang order dan order belum selesai.
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          err.code === "P2002"
        ) {
          if (isPaid) {
            const latestOrder = await prisma.order.findUnique({
              where: { id: payment.orderId },
              select: {
                status: true,
                winningPaymentId: true,
              },
            });

            if (
              latestOrder?.winningPaymentId === payment.id &&
              (latestOrder.status === "PAID" ||
                latestOrder.status === "FULFILLING")
            ) {
              try {
                await fulfillOrder(payment.orderId);

                return reply.send({
                  status: "OK",
                  message: "Fulfillment berhasil dipulihkan.",
                });
              } catch (fulfillmentError) {
                request.log.error(
                  {
                    err: fulfillmentError,
                    orderId: payment.orderId,
                    eventId,
                  },
                  "Pemulihan fulfillment dari webhook duplikat gagal.",
                );

                return reply.code(500).send({
                  error: "Fulfillment belum selesai.",
                });
              }
            }
          }

          return reply.send({
            status: "OK",
            message: "Event sudah pernah diproses.",
          });
        }

        request.log.error(
          { err, eventId, invoiceId: data.id },
          "Gagal memproses webhook WaroengPay.",
        );

        return reply.code(500).send({
          error: "Webhook belum berhasil diproses.",
        });
      }

      if (shouldFulfill) {
        try {
          await fulfillOrder(payment.orderId);
        } catch (err) {
          request.log.error(
            { err, orderId: payment.orderId, eventId },
            "Fulfillment WaroengPay gagal.",
          );

          return reply.code(500).send({
            error: "Pembayaran tercatat, tetapi fulfillment belum selesai.",
          });
        }
      }

      return reply.send({
        status: "OK",
        message: isPaid
          ? shouldFulfill
            ? "Pembayaran berhasil diproses."
            : "Pembayaran dicatat."
          : "Status invoice berhasil diperbarui.",
      });
    },
  );

  // 4. Endpoint pembayaran demo
  app.post<{
    Params: { orderId: string };
  }>("/api/payments/demo/:orderId/pay", async (request, reply) => {
    if (env.NODE_ENV !== "development") {
      return reply.code(404).send({
        error: "Endpoint pembayaran demo tidak tersedia.",
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

    if (order.status === "PAID" || order.status === "FULFILLED") {
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

    const payment = order.payments.find((item) => item.status === "PENDING");

    if (!payment) {
      return reply.code(400).send({
        error: "Payment pending tidak ditemukan",
      });
    }

    if (payment.provider !== "DEMO") {
      return reply.code(409).send({
        error: "Order ini bukan pembayaran demo.",
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
        const claimedOrder = await tx.order.updateMany({
  where: {
    id: order.id,
    status: "PENDING",
    winningPaymentId: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  },
  data: {
    status: "PAID",
    paidAt: now,
    winningPaymentId: payment.id,
  },
});

        if (claimedOrder.count !== 1) {
          throw new Error("ORDER_EXPIRED_OR_ALREADY_PROCESSED");
        }

        const updatedPayment = await tx.payment.updateMany({
  where: {
    id: payment.id,
    orderId: order.id,
    provider: "DEMO",
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

  // 4. Endpoint simulasi aktivasi MikroTik
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

  // 5. Endpoint konfirmasi pembayaran manual oleh admin
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

            try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          WITH lock_result AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(hashtext(${order.id}))
          )
          SELECT 1::int AS locked FROM lock_result
        `;

                const activeGatewayPayment = await tx.payment.findFirst({
          where: {
            orderId: order.id,
            provider: {
              in: ["MIDTRANS", "WAROENGPAY"],
            },
            status: "PENDING",
          },
          select: {
            id: true,
            provider: true,
          },
        });

        if (activeGatewayPayment) {
          throw new Error("ACTIVE_GATEWAY_PAYMENT_EXISTS");
        }

        const cashPayment = await tx.payment.create({
          data: {
            orderId: order.id,
            provider: "CASH",
            method: "MANUAL",
            amount: order.amount,
            status: "PAID",
            paidAt: now,
            providerTransactionId: `MANUAL-${order.orderNumber}`,
            ...(reference ? { rawResponse: { reference } } : {}),
          },
        });

        const claimedOrder = await tx.order.updateMany({
          where: {
            id: order.id,
            status: "PENDING",
            winningPaymentId: null,
            voucherId: order.voucherId,
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: now } },
            ],
          },
          data: {
            status: "PAID",
            paidAt: now,
            winningPaymentId: cashPayment.id,
          },
        });

        if (claimedOrder.count !== 1) {
          throw new Error("ORDER_CHANGED");
        }
      });

      const fulfillmentResult = await fulfillOrder(order.id);

      return reply.send({
        ok: true,
        message: "Pembayaran dikonfirmasi dan order dipenuhi.",
        orderNumber: order.orderNumber,
        voucherCode: fulfillmentResult.voucher?.code,
      });
        } catch (err) {
      if (
        err instanceof Error &&
        err.message === "ACTIVE_GATEWAY_PAYMENT_EXISTS"
      ) {
        return reply.code(409).send({
          error:
            "Order masih memiliki invoice pembayaran online aktif. Batalkan atau tunggu invoice kedaluwarsa sebelum mengonfirmasi pembayaran manual.",
        });
      }

      request.log.error(err);
      return reply.code(500).send({
        error: "Gagal mengonfirmasi pembayaran manual.",
      });
    }
  });
}
