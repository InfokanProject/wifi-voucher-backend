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
  // 1. Membuat transaksi Midtrans Snap
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

    const order = await prisma.order.findUnique({
      where: { id: request.params.orderId },
      include: {
        package: true,
        payments: true,
      },
    });

    if (!order) {
      return reply.code(404).send({
        error: "Order tidak ditemukan.",
      });
    }

    const now = new Date();

    if (
      order.status !== "PENDING" ||
      !order.voucherId ||
      (order.expiresAt !== null && order.expiresAt <= now)
    ) {
      return reply.code(409).send({
        error: "Order tidak lagi bisa dibayar.",
      });
    }

            const client = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          WITH lock_result AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(hashtext(${order.id}))
          )
          SELECT 1::int AS locked FROM lock_result
        `;
          const currentOrder = await tx.order.findUnique({
          where: { id: order.id },
          include: { package: true },
        });

        if (
          !currentOrder ||
          currentOrder.status !== "PENDING" ||
          !currentOrder.voucherId ||
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
          return { conflict: true as const };
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
          const saved = existing.rawResponse;

          if (
            saved &&
            typeof saved === "object" &&
            !Array.isArray(saved) &&
            typeof (saved as Record<string, unknown>).redirectUrl === "string"
          ) {
            return {
              existing: true,
              order: currentOrder,
              payment: existing,
              redirectUrl: (saved as Record<string, unknown>).redirectUrl as string,
              token:
                typeof (saved as Record<string, unknown>).token === "string"
                  ? (saved as Record<string, unknown>).token as string
                  : null,
            };
          }

          throw new Error("MIDTRANS_PAYMENT_ALREADY_EXISTS");
        }

        const payment = await tx.payment.create({
          data: {
            orderId: currentOrder.id,
            provider: "MIDTRANS",
            method: "QRIS",
            amount: currentOrder.amount,
            status: "PENDING",
          },
        });

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
              order_id: currentOrder.orderNumber,
              gross_amount: currentOrder.amount,
            },
            callbacks: {
              finish: `${env.PUBLIC_APP_URL}/beli`,
            },
            item_details: [
              {
                id: currentOrder.package.code,
                price: currentOrder.amount,
                quantity: 1,
                name: `Voucher WiFi ${currentOrder.package.name}`,
              },
            ],
            customer_details: {
              email,
              phone: currentOrder.customerIdentifier || "",
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
              orderNumber: currentOrder.orderNumber,
              httpStatus: response.status,
              errors: result.error_messages,
            },
            "Midtrans menolak pembuatan transaksi Snap",
          );

          throw new Error("MIDTRANS_SNAP_CREATION_FAILED");
        }

        await tx.payment.update({
          where: { id: payment.id },
          data: {
            rawResponse: {
              token: result.token,
              redirectUrl: result.redirect_url,
            },
          },
        });

        return {
          existing: false,
          order: currentOrder,
          payment,
          redirectUrl: result.redirect_url,
          token: result.token,
        };
      },
      {
        maxWait: 10000,
        timeout: 30000,
      },
    );

        if ("conflict" in client) {
      return reply.code(409).send({
        error: "Order sudah memiliki invoice aktif dari gateway lain.",
      });
    }

    return reply.send({
      orderId: client.order.id,
      orderNumber: client.order.orderNumber,
      amount: client.order.amount,
      redirectUrl: client.redirectUrl,
      token: client.token,
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

    const order = await prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      return reply.code(404).send({
        error: "Order tidak ditemukan.",
      });
    }

    const now = new Date();

    if (
      order.status !== "PENDING" ||
      !order.voucherId ||
      (order.expiresAt !== null && order.expiresAt <= now)
    ) {
      return reply.code(409).send({
        error: "Order tidak lagi bisa dibayar.",
      });
    }

    if (
      order.expiresAt &&
      order.expiresAt.getTime() - now.getTime() < 5 * 60 * 1000
    ) {
      return reply.code(409).send({
        error: "Sisa waktu order kurang dari 5 menit. Buat order baru.",
      });
    }

    try {
      const result = await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            WITH lock_result AS MATERIALIZED (
              SELECT pg_advisory_xact_lock(hashtext(${order.id}))
            )
            SELECT 1::int AS locked FROM lock_result
          `;

          const currentOrder = await tx.order.findUnique({
            where: { id: order.id },
            include: { package: true },
          });

          if (
            !currentOrder ||
            currentOrder.status !== "PENDING" ||
            !currentOrder.voucherId ||
            (currentOrder.expiresAt !== null &&
              currentOrder.expiresAt <= new Date())
          ) {
            throw new Error("ORDER_NOT_PAYABLE");
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

          if (
            existing?.providerTransactionId &&
            existing.rawResponse &&
            typeof existing.rawResponse === "object" &&
            !Array.isArray(existing.rawResponse)
          ) {
            const saved = existing.rawResponse as Record<string, unknown>;

            if (
              typeof saved.pay_url === "string" &&
              typeof saved.amount === "number"
            ) {
              return {
                order: currentOrder,
                invoiceId: existing.providerTransactionId,
                amount: existing.amount,
                payUrl: saved.pay_url,
                qris: saved.qris ?? null,
                expiresAt: saved.expires_at ?? null,
              };
            }
          }

          const remainingMinutes = currentOrder.expiresAt
            ? Math.floor(
                (currentOrder.expiresAt.getTime() - Date.now()) / 60000,
              )
            : 60;

          if (remainingMinutes < 5) {
            throw new Error("ORDER_EXPIRING_SOON");
          }

          const expiresIn = Math.min(60, remainingMinutes);

          const payment =
            existing ??
            (await tx.payment.create({
              data: {
                orderId: currentOrder.id,
                provider: "WAROENGPAY",
                method: "QRIS",
                amount: currentOrder.amount,
                status: "PENDING",
              },
            }));

          const response = await fetch(
            "https://waroengpay.com/api/payments",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${env.WAROENGPAY_API_KEY}`,
                "Content-Type": "application/json",
                Accept: "application/json",
                "Idempotency-Key": currentOrder.orderNumber,
              },
              body: JSON.stringify({
                amount: currentOrder.amount,
                description: `Voucher WiFi ${currentOrder.package.name}`,
                callback_url: `${env.PUBLIC_APP_URL}/api/payments/waroengpay/webhook`,
                redirect_url: `${env.PUBLIC_APP_URL}/beli`,
                expires_in: expiresIn,
              }),
              signal: AbortSignal.timeout(15000),
            },
          );

          const invoice = (await response.json()) as Record<string, unknown>;

          if (
            !response.ok ||
            typeof invoice.id !== "string" ||
            typeof invoice.base_amount !== "number" ||
            typeof invoice.amount !== "number" ||
            typeof invoice.pay_url !== "string" ||
            invoice.base_amount !== currentOrder.amount ||
            !Number.isInteger(invoice.amount) ||
            invoice.amount < invoice.base_amount ||
            invoice.livemode !== false
          ) {
            request.log.error(
              {
                orderNumber: currentOrder.orderNumber,
                httpStatus: response.status,
                response: invoice,
              },
              "WaroengPay menolak pembuatan invoice atau respons tidak valid.",
            );

            throw new Error("WAROENGPAY_INVOICE_CREATION_FAILED");
          }

          const savedInvoice = {
            ...invoice,
          };

          await tx.payment.update({
            where: { id: payment.id },
            data: {
              amount: invoice.amount,
              providerTransactionId: invoice.id,
              rawResponse: savedInvoice as any,
            },
          });

          return {
            order: currentOrder,
            invoiceId: invoice.id,
            amount: invoice.amount,
            payUrl: invoice.pay_url,
            qris: invoice.qris ?? null,
            expiresAt: invoice.expires_at ?? null,
          };
        },
        {
          maxWait: 10000,
          timeout: 30000,
        },
      );

      return reply.send({
        ok: true,
        orderId: result.order.id,
        orderNumber: result.order.orderNumber,
        invoiceId: result.invoiceId,
        amount: result.amount,
        payUrl: result.payUrl,
        qris: result.qris,
        expiresAt: result.expiresAt,
      });
        } catch (err) {
      request.log.error(
        { err, orderId },
        "Gagal membuat invoice WaroengPay.",
      );

      if (
        err instanceof Error &&
        (err.message === "ORDER_NOT_PAYABLE" ||
          err.message === "ORDER_EXPIRING_SOON" ||
          err.message === "OTHER_GATEWAY_PAYMENT_PENDING")
      ) {
        return reply.code(409).send({
          error:
            err.message === "OTHER_GATEWAY_PAYMENT_PENDING"
              ? "Order sudah memiliki invoice aktif dari gateway lain."
              : "Order tidak lagi bisa dibayar.",
        });
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