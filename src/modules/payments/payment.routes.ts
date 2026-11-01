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

        const pendingPayments = order.payments.filter(
      (item) => item.status === "PENDING",
    );

    if (pendingPayments.length !== 1) {
      request.log.warn(
        {
          orderNumber: order.orderNumber,
          pendingPaymentCount: pendingPayments.length,
        },
        "Jumlah payment pending tidak sesuai.",
      );

      return reply.code(409).send({
        error: "Payment pending tidak ditemukan atau tidak unik.",
      });
    }

    const payment = pendingPayments[0];

    if (payment.amount !== order.amount) {
      return reply.code(409).send({
        error: "Nominal payment tidak cocok dengan order.",
      });
    }

    if (payment.provider === "MIDTRANS") {
      const saved = payment.rawResponse;

      if (
        saved &&
        typeof saved === "object" &&
        !Array.isArray(saved) &&
        typeof (saved as Record<string, unknown>).redirectUrl === "string"
      ) {
        return reply.send({
          orderId: order.id,
          orderNumber: order.orderNumber,
          amount: order.amount,
          redirectUrl: (saved as Record<string, unknown>).redirectUrl,
          token: (saved as Record<string, unknown>).token ?? null,
        });
      }

      return reply.code(409).send({
        error: "Transaksi Midtrans sudah diproses. Periksa status pesanan.",
      });
    }

    if (payment.provider !== "DEMO") {
      return reply.code(409).send({
        error: "Provider payment tidak sesuai.",
      });
    }

    const authHeader = `Basic ${Buffer.from(env.MIDTRANS_SERVER_KEY + ":").toString("base64")}`;
    const snapUrl = getSnapUrl();

    let midtransResponse: Response;

    try {
      midtransResponse = await fetch(snapUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: authHeader,
          "X-Override-Notification": `${env.PUBLIC_APP_URL}/api/payments/midtrans/notification`,
        },
        body: JSON.stringify({
          transaction_details: {
            order_id: order.orderNumber,
            gross_amount: order.amount,
          },
            callbacks: {
            finish: `${env.PUBLIC_APP_URL}/beli`,
          },
          item_details: [
            {
              id: order.package.code,
              price: order.amount,
              quantity: 1,
              name: `Voucher WiFi ${order.package.name}`,
            },
          ],
          customer_details: {
            email,
            phone: order.customerIdentifier || "",
          },
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      request.log.error(
        { err: error, orderNumber: order.orderNumber },
        "Request Snap Midtrans gagal",
      );

      return reply.code(502).send({
        error: "Midtrans tidak bisa dihubungi. Silakan coba lagi.",
      });
    }

    let result: {
      token?: string;
      redirect_url?: string;
      error_messages?: string[];
    };

    try {
      result = await midtransResponse.json();
    } catch {
      return reply.code(502).send({
        error: "Respons Snap Midtrans tidak valid.",
      });
    }

    if (
      !midtransResponse.ok ||
      typeof result.redirect_url !== "string" ||
      typeof result.token !== "string"
    ) {
      request.log.warn(
        {
          orderNumber: order.orderNumber,
          httpStatus: midtransResponse.status,
          errors: result.error_messages,
        },
        "Midtrans menolak pembuatan transaksi Snap",
      );

      return reply.code(502).send({
        error: "Gagal membuat transaksi Midtrans. Periksa konfigurasi.",
      });
    }

    try {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.payment.updateMany({
          where: {
            id: payment.id,
            orderId: order.id,
            provider: "DEMO",
            status: "PENDING",
          },
          data: {
            provider: "MIDTRANS",
            method: "QRIS",
            rawResponse: {
              token: result.token,
              redirectUrl: result.redirect_url,
            },
          },
        });

        if (updated.count !== 1) {
          throw new Error("PAYMENT_CHANGED_DURING_TRANSACTION_CREATION");
        }
      });
    } catch (error) {
      request.log.error(
        { err: error, orderNumber: order.orderNumber },
        "Transaksi Snap dibuat tetapi penyimpanan payment gagal",
      );

      return reply.code(409).send({
        error: "Transaksi mungkin sudah dibuat. Periksa status pesanan.",
      });
    }

    return reply.send({
      orderId: order.id,
      orderNumber: order.orderNumber,
      amount: order.amount,
      redirectUrl: result.redirect_url,
      token: result.token,
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
  if (order.status === "FULFILLED") {
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

  // Pemulihan fulfillment jika pembayaran sudah tercatat.
  if (
    order.status === "PAID" ||
    order.status === "FULFILLING"
  ) {
    try {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: "PAID",
          paidAt: payment.paidAt ?? now,
          providerTransactionId:
            transactionId || payment.providerTransactionId,
rawResponse: verifiedRawResponse as any,        },
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
      const claimed = await tx.order.updateMany({
        where: {
          id: order.id,
          status: "PENDING",
        },
        data: {
          status: "PAID",
          paidAt: now,
        },
      });

      if (claimed.count !== 1) {
        throw new Error("ORDER_ALREADY_PROCESSED");
      }

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: "PAID",
          paidAt: now,
          providerTransactionId: transactionId,
rawResponse: verifiedRawResponse as any,        },
      });
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

  // 3. Endpoint pembayaran demo
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
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
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

    const payment = order.payments.find(
      (item) => item.status === "PENDING",
    );

    if (!payment) {
      return reply.code(409).send({
        error: "Order tidak memiliki pembayaran pending.",
      });
    }

    try {
      await prisma.$transaction(async (tx) => {
        const claimedOrder = await tx.order.updateMany({
          where: {
            id: order.id,
            status: "PENDING",
          },
          data: {
            status: "PAID",
            paidAt: now,
          },
        });

        if (claimedOrder.count !== 1) {
          throw new Error("ORDER_CHANGED");
        }

        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: "PAID",
            paidAt: now,
            providerTransactionId: reference || `MANUAL-${Date.now()}`,
          },
        });
      });

      const fulfillmentResult = await fulfillOrder(order.id);

      return reply.send({
        ok: true,
        message: "Pembayaran dikonfirmasi dan order dipenuhi.",
        orderNumber: order.orderNumber,
        voucherCode: fulfillmentResult.voucher?.code,
      });
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({
        error: "Gagal mengonfirmasi pembayaran manual.",
      });
    }
  });
}