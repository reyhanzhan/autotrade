const WIB_TIME_ZONE = "Asia/Jakarta";

export function formatWibDateTime(value: Date | string): string {
  return new Date(value).toLocaleString("id-ID", {
    timeZone: WIB_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }) + " WIB";
}

export function formatWibTime(value: Date | string): string {
  return new Date(value).toLocaleTimeString("id-ID", {
    timeZone: WIB_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }) + " WIB";
}
