import { RouterOSAPI } from "routeros-client";
import { env } from "../config/env";

export function createMikrotikClient() {
  return new RouterOSAPI({
    host: env.MIKROTIK_HOST,
    user: env.MIKROTIK_USERNAME,
    password: env.MIKROTIK_PASSWORD,
    port: env.MIKROTIK_PORT,
  });
}

export async function getMikrotikUsers() {
  const api = createMikrotikClient();

  try {
    await api.connect();

    const users = await api.write("/ip/hotspot/user/print");

    return users;
  } finally {
    await api.close();
  }
}

export async function getMikrotikUser(username: string) {
  const api = createMikrotikClient();

  try {
    await api.connect();

    const users = await api.write("/ip/hotspot/user/print", [
      `?name=${username}`,
    ]);

    return users[0] ?? null;
  } finally {
    await api.close();
  }
}

export async function createMikrotikUser({
  username,
  password,
  profile,
}: {
  username: string;
  password: string;
  profile: string;
}) {
  const api = createMikrotikClient();

  try {
    await api.connect();

    const existingUsers = await api.write("/ip/hotspot/user/print", [
      `?name=${username}`,
    ]);

    if (existingUsers.length > 0) {
      return {
        created: false,
        user: existingUsers[0],
      };
    }

    await api.write("/ip/hotspot/user/add", [
      `=name=${username}`,
      `=password=${password}`,
      `=profile=${profile}`,
      "=comment=NEW",
    ]);

    const createdUser = await api.write("/ip/hotspot/user/print", [
      `?name=${username}`,
    ]);

    return {
      created: true,
      user: createdUser[0] ?? null,
    };
  } finally {
    await api.close();
  }
}