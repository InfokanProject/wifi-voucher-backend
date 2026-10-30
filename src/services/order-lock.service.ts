import { Pool, type PoolClient } from "pg";
import { env } from "../config/env";

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

export async function withOrderLock<T>(
  orderId: string,
  callback: () => Promise<T>
): Promise<T> {
  const client: PoolClient = await pool.connect();

  let lockAcquired = false;
  let destroyConnection = false;

  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [`wifi-voucher-fulfillment:${orderId}`]
    );

    lockAcquired = result.rows[0]?.locked === true;

    if (!lockAcquired) {
      throw new Error("ORDER_FULFILLMENT_ALREADY_CLAIMED");
    }

    return await callback();
  } finally {
    if (lockAcquired) {
      try {
        const result = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
          [`wifi-voucher-fulfillment:${orderId}`]
        );

        if (result.rows[0]?.unlocked !== true) {
          destroyConnection = true;
        }
      } catch {
        destroyConnection = true;
      }
    }

    client.release(
      destroyConnection
        ? new Error("Gagal memastikan advisory lock dilepas.")
        : undefined
    );
  }
}