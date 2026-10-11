
import { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { env } from "../../config/env";

function safeCompare(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return timingSafeEqual(aBuffer, bBuffer);
}

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { password?: string } }>(
    "/api/admin/login",
    async (request, reply) => {
      const password = request.body?.password;

      if (typeof password !== "string" || password.length > 256) {
        return reply.code(400).send({
          error: "Password wajib diisi."
        });
      }

      if (!safeCompare(password, env.ADMIN_PASSWORD)) {
        return reply.code(401).send({
          error: "Password admin salah."
        });
      }

      await request.session.regenerate();
      request.session.set("isAdmin", true);

      return reply.send({
        ok: true,
        message: "Login admin berhasil."
      });
    }
  );

  app.get("/api/admin/session", async (request, reply) => {
    if (request.session.get("isAdmin") !== true) {
      return reply.code(401).send({
        authenticated: false
      });
    }

    return reply.send({
      authenticated: true
    });
  });

  app.post("/api/admin/logout", async (request, reply) => {
    await request.session.destroy();

    return reply.send({
      ok: true,
      message: "Logout berhasil."
    });
  });
}