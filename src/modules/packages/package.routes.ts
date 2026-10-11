import { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma";

export async function packageRoutes(app: FastifyInstance) {
  app.get("/api/packages", async () => {
    return prisma.package.findMany({
      where: { isActive: true },
      orderBy: { price: "asc" }
    });
  });
}
