/*
  Warnings:

  - A unique constraint covering the columns `[idempotencyKey]` on the table `orders` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "public"."orders" ADD COLUMN     "idempotencyKey" VARCHAR(80);

-- CreateIndex
CREATE UNIQUE INDEX "orders_idempotencyKey_key" ON "public"."orders"("idempotencyKey");
