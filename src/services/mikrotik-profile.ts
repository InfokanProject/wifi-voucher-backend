const profileByPackageCode: Record<string, string> = {
  "12J": "Paket-12J",
  "1H": "Paket-1H",
  "3H": "Paket-3H",
  "7H": "Paket-7H",
  "14H": "Paket-14H",
  "30H": "Paket-30H",
};

export function getMikrotikProfile(packageCode: string) {
  const profile = profileByPackageCode[packageCode];

  if (!profile) {
    throw new Error(
      `Profile MikroTik tidak ditemukan untuk paket ${packageCode}`
    );
  }

  return profile;
}