
import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { env } from "./config/env";
import { authRoutes } from "./modules/auth/auth.routes";
import { paymentRoutes } from "./modules/payments/payment.routes";
import { packageRoutes } from "./modules/packages/package.routes";
import { voucherRoutes } from "./modules/vouchers/voucher.routes";
import { orderRoutes } from "./modules/orders/order.routes";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.register(cors, {
    origin: true,
    credentials: true
  });

  app.register(sensible);
  app.register(cookie);

  app.register(session, {
    secret: env.SESSION_SECRET,
    cookieName: "wifi_admin_session",
    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      maxAge: 8 * 60 * 60 * 1000
    },
    saveUninitialized: false
  });

  app.get("/", async (_request, reply) => {
    const html = await readFile(
      resolve(process.cwd(), "public", "index.html"),
      "utf8"
    );

    return reply
      .type("text/html; charset=utf-8")
      .send(html);
  });

  app.get("/health", async () => ({
    ok: true,
    service: "wifi-voucher-backend"
  }));

  app.register(authRoutes);
  app.register(packageRoutes);
  app.register(voucherRoutes);
  app.register(orderRoutes);
  app.register(paymentRoutes);

  return app;
}
