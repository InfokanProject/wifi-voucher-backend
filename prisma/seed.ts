import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const packages = [
  { code: "12J",  name: "12 Jam",  durationMinutes: 12 * 60,       speedMbps: 25, price: 3000 },
  { code: "1H",   name: "1 Hari",  durationMinutes: 24 * 60,       speedMbps: 10, price: 5000 },
  { code: "3H",   name: "3 Hari",  durationMinutes: 3 * 24 * 60,   speedMbps: 10, price: 10000 },
  { code: "7H",   name: "7 Hari",  durationMinutes: 7 * 24 * 60,   speedMbps: 15, price: 15000 },
  { code: "14H",  name: "14 Hari", durationMinutes: 14 * 24 * 60,  speedMbps: 15, price: 25000 },
  { code: "30H",  name: "30 Hari", durationMinutes: 30 * 24 * 60,  speedMbps: 25, price: 50000 }
];

async function main() {
  for (const item of packages) {
    await prisma.package.upsert({
      where: { code: item.code },
      update: item,
      create: item
    });
  }

  console.log("Seed selesai: 6 paket WiFi tersedia.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
