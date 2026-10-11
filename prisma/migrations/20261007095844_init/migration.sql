-- CreateEnum
CREATE TYPE "public"."VoucherStatus" AS ENUM ('STOCK', 'RESERVED', 'SOLD', 'ACTIVATED', 'EXPIRED', 'DISABLED');

-- CreateEnum
CREATE TYPE "public"."OrderStatus" AS ENUM ('PENDING', 'PAID', 'FULFILLED', 'EXPIRED', 'CANCELLED', 'PAYMENT_FAILED');

-- CreateEnum
CREATE TYPE "public"."PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "public"."PaymentMethod" AS ENUM ('QRIS', 'MANUAL', 'OTHER');

-- CreateTable
CREATE TABLE "public"."packages" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "speedMbps" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vouchers" (
    "id" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "password" VARCHAR(128) NOT NULL,
    "status" "public"."VoucherStatus" NOT NULL DEFAULT 'STOCK',
    "mikrotikUsername" VARCHAR(64),
    "mikrotikDeviceId" UUID,
    "reservedUntil" TIMESTAMP(3),
    "soldAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."orders" (
    "id" UUID NOT NULL,
    "orderNumber" VARCHAR(40) NOT NULL,
    "packageId" UUID NOT NULL,
    "voucherId" UUID,
    "customerIdentifier" VARCHAR(120),
    "amount" INTEGER NOT NULL,
    "status" "public"."OrderStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."payments" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "providerTransactionId" VARCHAR(160),
    "method" "public"."PaymentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "public"."PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "rawResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."mikrotik_devices" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "host" VARCHAR(255) NOT NULL,
    "apiPort" INTEGER NOT NULL DEFAULT 8728,
    "username" VARCHAR(100) NOT NULL,
    "passwordSecret" VARCHAR(255) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mikrotik_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."audit_logs" (
    "id" UUID NOT NULL,
    "action" VARCHAR(80) NOT NULL,
    "entityType" VARCHAR(80) NOT NULL,
    "entityId" VARCHAR(100),
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "packages_code_key" ON "public"."packages"("code");

-- CreateIndex
CREATE INDEX "packages_isActive_idx" ON "public"."packages"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_code_key" ON "public"."vouchers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_username_key" ON "public"."vouchers"("username");

-- CreateIndex
CREATE INDEX "vouchers_packageId_status_idx" ON "public"."vouchers"("packageId", "status");

-- CreateIndex
CREATE INDEX "vouchers_status_reservedUntil_idx" ON "public"."vouchers"("status", "reservedUntil");

-- CreateIndex
CREATE INDEX "vouchers_mikrotikDeviceId_idx" ON "public"."vouchers"("mikrotikDeviceId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_orderNumber_key" ON "public"."orders"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "orders_voucherId_key" ON "public"."orders"("voucherId");

-- CreateIndex
CREATE INDEX "orders_status_createdAt_idx" ON "public"."orders"("status", "createdAt");

-- CreateIndex
CREATE INDEX "orders_packageId_status_idx" ON "public"."orders"("packageId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payments_providerTransactionId_key" ON "public"."payments"("providerTransactionId");

-- CreateIndex
CREATE INDEX "payments_orderId_status_idx" ON "public"."payments"("orderId", "status");

-- CreateIndex
CREATE INDEX "payments_provider_status_idx" ON "public"."payments"("provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mikrotik_devices_name_key" ON "public"."mikrotik_devices"("name");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "public"."audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "public"."audit_logs"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."vouchers" ADD CONSTRAINT "vouchers_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "public"."packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vouchers" ADD CONSTRAINT "vouchers_mikrotikDeviceId_fkey" FOREIGN KEY ("mikrotikDeviceId") REFERENCES "public"."mikrotik_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "public"."packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "public"."vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."payments" ADD CONSTRAINT "payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
