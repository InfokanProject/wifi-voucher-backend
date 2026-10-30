
import { RouterOSAPI } from "routeros-client";
import { env } from "../config/env";

type SimulatedUser = {
  name: string;
  password: string;
  profile: string;
  comment: string;
};

const simulatedUsers = new Map<string, SimulatedUser>();

function createMikrotikClient() {
  if (env.MIKROTIK_MODE !== "real") {
    throw new Error(
      "Koneksi RouterOS dilarang saat MIKROTIK_MODE=simulator."
    );
  }

  return new RouterOSAPI({
    host: env.MIKROTIK_HOST,
    user: env.MIKROTIK_USERNAME,
    password: env.MIKROTIK_PASSWORD,
    port: env.MIKROTIK_PORT,
  });
}

export async function getMikrotikUsers() {
  if (env.MIKROTIK_MODE === "simulator") {
    return Array.from(simulatedUsers.values()).map((user) => ({
      ...user,
    }));
  }

  const api = createMikrotikClient();

  try {
    await api.connect();
    return await api.write("/ip/hotspot/user/print");
  } finally {
    await api.close();
  }
}

export async function getMikrotikUser(username: string) {
  if (env.MIKROTIK_MODE === "simulator") {
    const user = simulatedUsers.get(username);
    return user ? { ...user } : null;
  }

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
  if (env.MIKROTIK_MODE === "simulator") {
    const existing = simulatedUsers.get(username);

    if (existing) {
      if (
        existing.password !== password ||
        existing.profile !== profile
      ) {
        throw new Error(
          "SIMULATOR_USER_EXISTS_WITH_DIFFERENT_CREDENTIALS"
        );
      }

      return { created: false, user: { ...existing } };
    }

    const user: SimulatedUser = {
      name: username,
      password,
      profile,
      comment: "NEW",
    };

    simulatedUsers.set(username, user);

    return { created: true, user: { ...user } };
  }

  const api = createMikrotikClient();

  try {
    await api.connect();

    const existingUsers = await api.write(
      "/ip/hotspot/user/print",
      [`?name=${username}`]
    );

    if (existingUsers.length > 0) {
  const existingUser = existingUsers[0];

  const existingProfile = String(existingUser.profile ?? "");
  const existingComment = String(existingUser.comment ?? "");

  if (existingProfile !== profile) {
    throw new Error(
      "MIKROTIK_USER_EXISTS_WITH_DIFFERENT_PROFILE"
    );
  }

  const isManagedUser =
    existingComment === "NEW" ||
    existingComment.startsWith("ACTIVATED ");

  if (!isManagedUser) {
    throw new Error(
      "MIKROTIK_USER_EXISTS_BUT_NOT_MANAGED_BY_BACKEND"
    );
  }

  return {
    created: false,
    user: existingUser,
  };
}

    await api.write("/ip/hotspot/user/add", [
      `=name=${username}`,
      `=password=${password}`,
      `=profile=${profile}`,
      "=comment=NEW",
    ]);

    const createdUsers = await api.write(
      "/ip/hotspot/user/print",
      [`?name=${username}`]
    );

    return {
      created: true,
      user: createdUsers[0] ?? null,
    };
  } finally {
    await api.close();
  }
}

function formatSimulatedActivationTime(date: Date): string {
  const jakartaTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);

  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  const pad = (value: number) => String(value).padStart(2, "0");

  return (
    `ACTIVATED ${months[jakartaTime.getUTCMonth()]}/` +
    `${pad(jakartaTime.getUTCDate())}/` +
    `${jakartaTime.getUTCFullYear()} ` +
    `${pad(jakartaTime.getUTCHours())}:` +
    `${pad(jakartaTime.getUTCMinutes())}:` +
    `${pad(jakartaTime.getUTCSeconds())}`
  );
}

export async function simulateMikrotikActivation(
  username: string,
  activatedAt = new Date()
) {
  if (env.MIKROTIK_MODE !== "simulator") {
    throw new Error(
      "Simulasi aktivasi hanya boleh berjalan pada mode simulator."
    );
  }

  const user = simulatedUsers.get(username);

  if (!user) {
    throw new Error("SIMULATED_USER_NOT_FOUND");
  }

  user.comment = formatSimulatedActivationTime(activatedAt);
  simulatedUsers.set(username, user);

  return { ...user };
}


export async function deleteMikrotikUser(username: string) {
  if (env.MIKROTIK_MODE === "simulator") {
    const deleted = simulatedUsers.delete(username);

    return {
      found: deleted,
      deleted,
      mode: "simulator" as const,
    };
  }

  const api = createMikrotikClient();

  try {
    await api.connect();

    const users = await api.write("/ip/hotspot/user/print", [
      `?name=${username}`,
    ]);

    const user = users[0];

    if (!user) {
      return {
        found: false,
        deleted: false,
        mode: "real" as const,
      };
    }

    const userId = user[".id"];

    if (!userId) {
      throw new Error("MIKROTIK_USER_ID_NOT_FOUND");
    }

    await api.write("/ip/hotspot/user/remove", [
      `=.id=${userId}`,
    ]);

    return {
      found: true,
      deleted: true,
      mode: "real" as const,
    };
  } finally {
    await api.close();
  }
}

