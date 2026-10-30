import { createHmac, timingSafeEqual } from "node:crypto";

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


function verifyDuitkuSignature(
  input: string,
  signature: string,
  apiKey: string,
): boolean {
  const expected = createHmac("sha256", apiKey)
    .update(input)
    .digest("hex");

  const actualBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  return (
    actualBuffer.length === expectedBuffer.length &&
    actualBuffer.length > 0 &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}


export async function paymentRoutes(app: FastifyInstance) {
  
  // Membuat invoice Duitku Sandbox untuk order yang sudah ada.
  app.post<{
    Params: { orderId: string };
    Body: { email?: string };
  }>("/api/payments/duitku/:orderId/create", async (request, reply) => {
    if (
      env.DUITKU_MODE !== "sandbox" ||
      env.DUITKU_BASE_URL !==
        "https://api-sandbox.duitku.com/api/merchant/createInvoice"
    ) {
      return reply.code(503).send({
        error: "Endpoint ini khusus konfigurasi Duitku Sandbox.",
      });
    }

    if (
      !env.DUITKU_MERCHANT_CODE ||
      !env.DUITKU_API_KEY ||
      !env.DUITKU_CALLBACK_URL ||
      !env.DUITKU_RETURN_URL
    ) {
      return reply.code(503).send({
        error: "Konfigurasi Duitku belum lengkap.",
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

    const payment = order.payments.find(
      (item) => item.status === "PENDING",
    );

    if (!payment || payment.amount !== order.amount) {
      return reply.code(409).send({
        error: "Payment pending tidak ditemukan atau nominal tidak cocok.",
      });
    }

    // Request ulang tidak boleh membuat invoice berbeda untuk order sama.
    if (payment.provider === "DUITKU") {
      const saved = payment.rawResponse;

      if (
        saved &&
        typeof saved === "object" &&
        !Array.isArray(saved) &&
        typeof saved.paymentUrl === "string"
      ) {
        return reply.send({
          orderId: order.id,
          orderNumber: order.orderNumber,
          paymentUrl: saved.paymentUrl,
          reference: payment.providerTransactionId,
        });
      }

      return reply.code(409).send({
        error: "Invoice Duitku sudah diproses. Periksa status transaksi.",
      });
    }

    if (payment.provider !== "DEMO") {
      return reply.code(409).send({
        error: "Provider payment tidak sesuai.",
      });
    }

    const timestamp = Date.now().toString();

    const signature = createHmac("sha256", env.DUITKU_API_KEY)
      .update(env.DUITKU_MERCHANT_CODE + timestamp)
      .digest("hex");

    let duitkuResponse: Response;

    try {
      duitkuResponse = await fetch(env.DUITKU_BASE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-duitku-merchantcode": env.DUITKU_MERCHANT_CODE,
          "x-duitku-timestamp": timestamp,
          "x-duitku-signature": signature,
        },
        body: JSON.stringify({
          paymentAmount: order.amount,
          merchantOrderId: order.orderNumber,
          productDetails: `Voucher WiFi ${order.package.name}`,
          email,
          phoneNumber: order.customerIdentifier || "",
          customerVaName: "WiFi Kos",
          callbackUrl: env.DUITKU_CALLBACK_URL,
          returnUrl: env.DUITKU_RETURN_URL,
          expiryPeriod: 60,
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      request.log.error(
        { err: error, orderNumber: order.orderNumber },
        "Request invoice Duitku gagal",
      );

      return reply.code(502).send({
        error: "Duitku tidak bisa dihubungi. Periksa status invoice sebelum mencoba ulang.",
      });
    }

    let result: {
      reference?: string;
      paymentUrl?: string;
      statusCode?: string;
      statusMessage?: string;
    };

    try {
      result = await duitkuResponse.json();
    } catch {
      return reply.code(502).send({
        error: "Respons invoice Duitku tidak valid.",
      });
    }

    if (
      !duitkuResponse.ok ||
      result.statusCode !== "00" ||
      typeof result.reference !== "string" ||
      typeof result.paymentUrl !== "string" ||
      !/^https:\/\/app-sandbox\.duitku\.com\//.test(result.paymentUrl)
    ) {
      request.log.warn(
        {
          orderNumber: order.orderNumber,
          httpStatus: duitkuResponse.status,
          duitkuStatus: result.statusCode,
          duitkuMessage: result.statusMessage,
        },
        "Duitku menolak pembuatan invoice",
      );

      return reply.code(502).send({
        error: "Invoice gagal dibuat. Periksa konfigurasi atau status Duitku Sandbox.",
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
            provider: "DUITKU",
            method: "QRIS",
            providerTransactionId: result.reference,
            rawResponse: {
              reference: result.reference,
              paymentUrl: result.paymentUrl,
              statusCode: result.statusCode,
              statusMessage: result.statusMessage,
            },
          },
        });

        if (updated.count !== 1) {
          throw new Error("PAYMENT_CHANGED_DURING_INVOICE_CREATION");
        }
      });
    } catch (error) {
      request.log.error(
        { err: error, orderNumber: order.orderNumber },
        "Invoice dibuat tetapi penyimpanan payment gagal",
      );

      return reply.code(409).send({
        error: "Invoice mungkin sudah dibuat. Periksa transaksi sebelum mencoba ulang.",
      });
    }

    return reply.send({
      orderId: order.id,
      orderNumber: order.orderNumber,
      amount: order.amount,
      paymentUrl: result.paymentUrl,
      reference: result.reference,
    });
  });

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

    
  // Callback Duitku: status pembayaran hanya dipercaya jika signature valid.
  app.post<{
    Body: {
      merchantCode?: string;
      amount?: string;
      merchantOrderId?: string;
      resultCode?: string;
      reference?: string;
      signature?: string;
    };
  }>("/api/payments/duitku/callback", async (request, reply) => {
    const body = request.body ?? {};

    const merchantCode = body.merchantCode ?? "";
    const amount = body.amount ?? "";
    const merchantOrderId = body.merchantOrderId ?? "";
    const resultCode = body.resultCode ?? "";
    const reference = body.reference ?? "";
    const signature = body.signature ?? "";

    if (
      !env.DUITKU_MERCHANT_CODE ||
      !env.DUITKU_API_KEY
    ) {
      request.log.error("Konfigurasi callback Duitku belum lengkap.");
      return reply.code(503).send("Configuration error");
    }

    // Validasi identitas merchant dan signature dari Duitku.
    if (
      merchantCode !== env.DUITKU_MERCHANT_CODE ||
      !/^\d+$/.test(amount) ||
      !merchantOrderId ||
      !reference ||
      !/^[a-fA-F0-9]{64}$/.test(signature) ||
      !verifyDuitkuSignature(
        merchantCode + amount + merchantOrderId,
        signature,
        env.DUITKU_API_KEY,
      )
    ) {
      request.log.warn(
        { merchantOrderId },
        "Callback Duitku ditolak: signature atau identitas tidak valid.",
      );
      return reply.code(400).send("Invalid callback");
    }

    const order = await prisma.order.findUnique({
      where: { orderNumber: merchantOrderId },
      include: { payments: true },
    });

    if (!order) {
      request.log.warn(
        { merchantOrderId },
        "Callback Duitku diterima untuk order yang tidak ditemukan.",
      );
      return reply.code(404).send("Order not found");
    }

    const payment = order.payments.find(
      (item) =>
        item.provider === "DUITKU" &&
        item.providerTransactionId === reference,
    );

    if (
      !payment ||
      payment.amount !== order.amount ||
      Number(amount) !== order.amount
    ) {
      request.log.warn(
        { merchantOrderId, reference },
        "Callback Duitku ditolak: payment atau nominal tidak cocok.",
      );
      return reply.code(400).send("Payment mismatch");
    }

    // Callback dengan hasil selain sukses tidak melunasi order.
    if (resultCode !== "00") {
      request.log.info(
        { merchantOrderId, resultCode },
        "Callback Duitku bukan pembayaran sukses.",
      );
      return reply.code(200).send("OK");
    }

    // Callback sukses yang dikirim ulang harus tetap aman diproses.
    if (
      payment.status === "PAID" &&
      ["PAID", "FULFILLING", "FULFILLED"].includes(order.status)
    ) {
      if (order.status === "FULFILLED") {
        return reply.code(200).send("OK");
      }

      try {
        await fulfillOrder(order.id);
        return reply.code(200).send("OK");
      } catch (error) {
        request.log.error(
          { err: error, merchantOrderId },
          "Fulfillment ulang setelah callback Duitku gagal.",
        );
        return reply.code(500).send("Fulfillment failed");
      }
    }

    // Pembayaran sukses yang diterima setelah order kedaluwarsa.
if (
  order.status === "EXPIRED" &&
  payment.status === "EXPIRED"
) {
  try {
    await prisma.$transaction(async (tx) => {
      const updatedPayment = await tx.payment.updateMany({
        where: {
          id: payment.id,
          orderId: order.id,
          provider: "DUITKU",
          providerTransactionId: reference,
          status: "EXPIRED",
          amount: order.amount,
        },
        data: {
          status: "PAID",
          paidAt: new Date(),
        },
      });

      if (updatedPayment.count !== 1) {
        throw new Error("LATE_PAYMENT_ALREADY_PROCESSED");
      }

      await tx.auditLog.create({
        data: {
          action: "LATE_PAYMENT_RECONCILIATION_REQUIRED",
          entityType: "Order",
          entityId: order.id,
          description: `Pembayaran Duitku sukses diterima setelah order ${order.orderNumber} kedaluwarsa`,
          metadata: {
            orderNumber: order.orderNumber,
            paymentId: payment.id,
            reference,
            amount: order.amount,
            resultCode,
            previousOrderStatus: "EXPIRED",
            previousPaymentStatus: "EXPIRED",
            reconciliationRequired: true,
          },
        },
      });
    });

    request.log.warn(
      { merchantOrderId, reference },
      "Pembayaran terlambat tercatat. Order tetap EXPIRED dan perlu rekonsiliasi admin.",
    );

    return reply.code(200).send("OK");
  } catch (error) {
    request.log.error(
      { err: error, merchantOrderId, reference },
      "Gagal mencatat pembayaran terlambat.",
    );

    return reply.code(500).send("Late payment reconciliation failed");
  }
}

    if (
      order.status !== "PENDING" ||
      payment.status !== "PENDING"
    ) {
      request.log.warn(
        {
          merchantOrderId,
          orderStatus: order.status,
          paymentStatus: payment.status,
        },
        "Callback sukses perlu pemeriksaan status order.",
      );
      return reply.code(200).send("OK");
    }

    if (order.expiresAt && order.expiresAt <= new Date()) {
      request.log.error(
        { merchantOrderId, reference },
        "Pembayaran sukses diterima untuk order yang sudah kedaluwarsa; perlu rekonsiliasi.",
      );
      return reply.code(200).send("OK");
    }

    try {
      await prisma.$transaction(async (tx) => {
       const paidAt = new Date();

const claimedOrder = await tx.order.updateMany({
  where: {
    id: order.id,
    status: "PENDING",
    OR: [
      { expiresAt: null },
      { expiresAt: { gt: paidAt } },
    ],
  },
  data: {
    status: "PAID",
    paidAt,
  },
});

        if (claimedOrder.count !== 1) {
          throw new Error("ORDER_STATUS_CHANGED");
        }

        const claimedPayment = await tx.payment.updateMany({
          where: {
            id: payment.id,
            orderId: order.id,
            provider: "DUITKU",
            providerTransactionId: reference,
            status: "PENDING",
            amount: order.amount,
          },
          data: {
            status: "PAID",
            paidAt,
          },
        });

        if (claimedPayment.count !== 1) {
          throw new Error("PAYMENT_STATUS_CHANGED");
        }
      });
    } catch (error) {
      request.log.error(
        { err: error, merchantOrderId, reference },
        "Gagal mengubah status pembayaran Duitku.",
      );
      return reply.code(500).send("Payment update failed");
    }

    try {
      await fulfillOrder(order.id);
    } catch (error) {
      request.log.error(
        { err: error, merchantOrderId, reference },
        "Pembayaran sukses, tetapi fulfillment gagal.",
      );
      return reply.code(500).send("Fulfillment failed");
    }

    return reply.code(200).send("OK");
  });

}