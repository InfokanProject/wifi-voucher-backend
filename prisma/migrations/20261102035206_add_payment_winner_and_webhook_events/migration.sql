/*
  Warnings:

  - A unique constraint covering the columns `[winningPaymentId]` on the table `orders` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "public"."orders" ADD COLUMN     "winningPaymentId" UUID;

-- Backfill existing successful payments as winning payments
UPDATE "public"."orders" AS o
SET "winningPaymentId" = p."id"
FROM "public"."payments" AS p
WHERE p."orderId" = o."id"
  AND p."status" = 'PAID';

-- CreateTable
CREATE TABLE "public"."webhook_events" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "eventId" VARCHAR(160) NOT NULL,
    "eventType" VARCHAR(80) NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_events_provider_createdAt_idx" ON "public"."webhook_events"("provider", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_eventId_key" ON "public"."webhook_events"("provider", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_winningPaymentId_key" ON "public"."orders"("winningPaymentId");
