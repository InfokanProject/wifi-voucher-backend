
import { prisma } from "./src/lib/prisma";

async function main() {
  const voucher = await prisma.voucher.findFirst({
    where: { username: "Q7QYUMLC" },
    select: {
      id: true,
      username: true,
      status: true,
      mikrotikDeviceId: true,
      mikrotikUsername: true,
      activatedAt: true,
      expiresAt: true,
      reservedUntil: true,
      soldAt: true,
      order: {
        select: {
          id: true,
          orderNumber: true,
          status: true,
        },
      },
    },
  });

  console.log(JSON.stringify(voucher, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
