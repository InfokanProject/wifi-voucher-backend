
import { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma";
import { generateVoucherCode } from "../../utils/voucher-generator";

export async function voucherRoutes(app: FastifyInstance) {
  app.post<{
    Body: { packageCode: string; quantity: number };
  }>(
    "/api/admin/vouchers/generate",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["packageCode", "quantity"],
          properties: {
            packageCode: {
              type: "string",
              minLength: 1,
              maxLength: 20
            },
            quantity: {
              type: "integer",
              minimum: 1,
              maximum: 1000
            }
          }
        }
      }
    },
    async (request, reply) => {
      if (request.session.get("isAdmin") !== true) {
        return reply.code(401).send({ error: "Admin harus login." });
      }

      const { packageCode, quantity } = request.body;

      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
        return reply.code(400).send({ error: "quantity harus 1-1000" });
      }

      const pkg = await prisma.package.findUnique({
        where: { code: packageCode }
      });

      if (!pkg) {
        return reply.code(404).send({ error: "Paket tidak ditemukan" });
      }

      const created = [];

      for (let i = 0; i < quantity; i++) {
        let code = generateVoucherCode();

        while (await prisma.voucher.findUnique({ where: { code } })) {
          code = generateVoucherCode();
        }

        created.push({
          packageId: pkg.id,
          code,
          username: code,
          password: code
        });
      }

      await prisma.voucher.createMany({ data: created });

      return {
        message: "Voucher berhasil dibuat",
        package: pkg.code,
        quantity: created.length
      };
    }
  );

  app.get("/api/admin/vouchers", async (request, reply) => {
    if (request.session.get("isAdmin") !== true) {
      return reply.code(401).send({ error: "Admin harus login." });
    }

    return prisma.voucher.findMany({
      select: {
        id: true,
        code: true,
        status: true,
        createdAt: true,
        activatedAt: true,
        expiresAt: true,
        expiredAt: true,
        package: {
          select: {
            code: true,
            name: true,
            price: true,
            durationMinutes: true
          }
        },
        order: {
          select: {
            orderNumber: true,
            status: true,
            createdAt: true
          }
        }
      },
      orderBy: { createdAt: "desc" },
      take: 100
    });
  });
}
