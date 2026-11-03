
import { buildApp } from "./app";
import { env } from "./config/env";
import { syncAllVoucherActivations } from "./services/activation-sync.service";
import { expireDueVouchers } from "./services/voucher-expiration.service";
import { expireDueOrders } from "./services/order-expiration.service";
import { recoverStuckOrders } from "./services/order-recovery.service";

const app = buildApp();

const ACTIVATION_SYNC_INTERVAL = 30_000;
const VOUCHER_EXPIRATION_INTERVAL = 30_000;
const ORDER_EXPIRATION_INTERVAL = 30_000;
const ORDER_RECOVERY_INTERVAL = 60_000;
let orderRecoveryRunning = false;

let activationSyncRunning = false;

async function runActivationSync() {
  if (activationSyncRunning) {
    app.log.warn(
      "Voucher activation sync dilewati: proses sebelumnya masih berjalan"
    );
    return;
  }

  activationSyncRunning = true;

  try {
    const result = await syncAllVoucherActivations();

    app.log.info(
      {
        mikrotikActivatedUsers: result.mikrotikActivatedUsers,
        synced: result.synced,
        backfilled: result.backfilled,
        expired: result.expired,
        alreadyActivated: result.alreadyActivated,
        legacy: result.legacy,
      },
      "Voucher activation sync selesai"
    );
  } catch (error) {
    app.log.error(error, "Voucher activation sync gagal");
  } finally {
    activationSyncRunning = false;
  }
}

async function runVoucherExpiration() {
  try {
    const result = await expireDueVouchers();

    if (result.found > 0 || result.expired > 0) {
      app.log.info(
        {
          checkedAt: result.checkedAt.toISOString(),
          found: result.found,
          expired: result.expired,
        },
        "Voucher expiration check selesai"
      );
    }
  } catch (error) {
    app.log.error(error, "Voucher expiration check gagal");
  }
}

async function runOrderExpiration() {
  try {
    const result = await expireDueOrders();

    if (result.found > 0 || result.expired > 0) {
      app.log.info(
        {
          checkedAt: result.checkedAt.toISOString(),
          found: result.found,
          expired: result.expired,
          vouchersReleased: result.vouchersReleased,
        },
        "Order expiration check selesai"
      );
    }
  } catch (error) {
    app.log.error(error, "Order expiration check gagal");
  }
}

async function runOrderRecovery() {
  if (orderRecoveryRunning) {
    app.log.warn("Order recovery dilewati: proses sebelumnya masih berjalan");
    return;
  }

  orderRecoveryRunning = true;

  try {
    const result = await recoverStuckOrders();

    if (result.found > 0) {
      app.log.info(
        {
          found: result.found,
          recovered: result.recovered,
          skipped: result.skipped,
          failed: result.failed,
        },
        "Order recovery selesai"
      );
    }
  } catch (error) {
    app.log.error(error, "Order recovery gagal");
  } finally {
    orderRecoveryRunning = false;
  }
}

app.listen({ host: env.HOST, port: env.PORT })
  .then(async () => {
    console.log(
      `WiFi Voucher Backend running at http://localhost:${env.PORT}`
    );

    await Promise.all([
      runActivationSync(),
      runVoucherExpiration(),
      runOrderExpiration(),
      runOrderRecovery(),
    ]);

    setInterval(runActivationSync, ACTIVATION_SYNC_INTERVAL);
    setInterval(runVoucherExpiration, VOUCHER_EXPIRATION_INTERVAL);
    setInterval(runOrderExpiration, ORDER_EXPIRATION_INTERVAL);
    setInterval(runOrderRecovery, ORDER_RECOVERY_INTERVAL);
  })
  .catch(async (error) => {
    app.log.error(error);
    process.exit(1);
  });
