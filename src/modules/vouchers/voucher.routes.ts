
import { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma";
import { generateVoucherCode } from "../../utils/voucher-generator";
import { deleteMikrotikUser } from "../../services/mikrotik.service";

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
        return reply.code(401).send({
          error: "Admin harus login."
        });
      }

      const { packageCode, quantity } = request.body;

      if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 1000
      ) {
        return reply.code(400).send({
          error: "quantity harus 1-1000"
        });
      }

      const pkg = await prisma.package.findUnique({
        where: { code: packageCode }
      });

      if (!pkg) {
        return reply.code(404).send({
          error: "Paket tidak ditemukan"
        });
      }

      const created = [];

      for (let i = 0; i < quantity; i++) {
        let code = generateVoucherCode();

        while (
          await prisma.voucher.findUnique({
            where: { code }
          })
        ) {
          code = generateVoucherCode();
        }

        created.push({
          packageId: pkg.id,
          code,
          username: code,
          password: code
        });
      }

      await prisma.voucher.createMany({
        data: created
      });

      return {
        message: "Voucher berhasil dibuat",
        package: pkg.code,
        quantity: created.length
      };
    }
  );

  app.get("/api/admin/vouchers", async (request, reply) => {
    if (request.session.get("isAdmin") !== true) {
      return reply.code(401).send({
        error: "Admin harus login."
      });
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

  app.delete<{
    Params: { id: string };
  }>(
    "/api/admin/vouchers/:id",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: {
              type: "string",
              format: "uuid"
            }
          }
        }
      }
    },
    async (request, reply) => {
      if (request.session.get("isAdmin") !== true) {
        return reply.code(401).send({
          error: "Admin harus login."
        });
      }

      const { id } = request.params;

      const voucher = await prisma.voucher.findUnique({
        where: { id },
        include: { order: true }
      });

      if (!voucher) {
        return reply.code(404).send({
          error: "Voucher tidak ditemukan."
        });
      }

      if (voucher.status !== "STOCK" || voucher.order) {
        return reply.code(409).send({
          error:
            "Hanya voucher STOCK yang belum terhubung ke order yang boleh dihapus."
        });
      }

      // Klaim voucher sementara agar tidak ikut dipesan.
      const claimed = await prisma.voucher.updateMany({
        where: {
          id,
          status: "STOCK",
          order: { is: null }
        },
        data: {
          status: "DISABLED"
        }
      });

      if (claimed.count !== 1) {
        return reply.code(409).send({
          error: "Status voucher berubah. Muat ulang data."
        });
      }

      let mikrotikResult:
        | {
            found: boolean;
            deleted: boolean;
            mode: "real" | "simulator";
          }
        | undefined;

      try {
        mikrotikResult = await deleteMikrotikUser(
          voucher.username
        );

        const result = await prisma.$transaction(async (tx) => {
          const current = await tx.voucher.findUnique({
            where: { id },
            include: { order: true }
          });

          if (
            !current ||
            current.status !== "DISABLED" ||
            current.order
          ) {
            throw new Error(
              "VOUCHER_CHANGED_DURING_DELETION"
            );
          }

          const deleted = await tx.voucher.deleteMany({
            where: {
              id,
              status: "DISABLED",
              order: { is: null }
            }
          });

          if (deleted.count !== 1) {
            throw new Error("VOUCHER_DELETE_CONFLICT");
          }

          await tx.auditLog.create({
            data: {
              action: "DELETE_STOCK_VOUCHER",
              entityType: "Voucher",
              entityId: voucher.id,
              description:
                `Voucher stok ${voucher.username} dihapus`,
              metadata: {
                username: voucher.username,
                packageId: voucher.packageId,
                mode: mikrotikResult!.mode,
                mikrotikUserFound: mikrotikResult!.found,
                mikrotikUserDeleted: mikrotikResult!.deleted
              }
            }
          });

          return { deleted: true };
        });

        return {
          message: "Voucher stok berhasil dihapus.",
          ...result,
          mikrotik: mikrotikResult
        };
      } catch (error) {
        await prisma.voucher.updateMany({
          where: {
            id,
            status: "DISABLED",
            order: { is: null }
          },
          data: {
            status: "STOCK"
          }
        }).catch(() => undefined);

        request.log.error(
          { err: error, voucherId: id },
          "Gagal menghapus voucher stok"
        );

        return reply.code(500).send({
          error:
            "Penghapusan gagal. Periksa status voucher dan koneksi MikroTik sebelum mencoba lagi."
        });
      }
    }
  );
}
