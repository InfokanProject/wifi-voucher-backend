
const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export function parseActivationTime(
  comment: string
): Date | null {
  const match = comment.match(
    /^ACTIVATED\s+([a-z]{3})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/i
  );

  if (!match) {
    return null;
  }

  const [, monthText, dayText, yearText, hourText, minuteText, secondText] =
    match;

  const month = MONTHS[monthText.toLowerCase()];

  if (month === undefined) {
    return null;
  }

  const year = Number(yearText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);

  if (
    year < 1 ||
    day < 1 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  const isLeapYear =
    year % 4 === 0 &&
    (year % 100 !== 0 || year % 400 === 0);

  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  if (day > daysInMonth[month]) {
    return null;
  }

  const pad = (value: number) => String(value).padStart(2, "0");

  const timestamp =
    `${yearText}-${pad(month + 1)}-${pad(day)}` +
    `T${pad(hour)}:${pad(minute)}:${pad(second)}+07:00`;

  const activatedAt = new Date(timestamp);

  if (Number.isNaN(activatedAt.getTime())) {
    return null;
  }

  return activatedAt;
}

export function calculateExpiresAt(
  activatedAt: Date,
  durationMinutes: number
): Date {
  if (
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0
  ) {
    throw new Error("INVALID_VOUCHER_DURATION");
  }

  return new Date(
    activatedAt.getTime() + durationMinutes * 60_000
  );
}
