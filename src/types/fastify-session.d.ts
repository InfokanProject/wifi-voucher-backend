
import "fastify";

declare module "fastify" {
  interface Session {
    isAdmin?: boolean;
  }
}