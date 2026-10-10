/** China Standard Time is a fixed UTC+8 offset (no daylight saving). */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function shanghaiDate(date: Date): string {
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** Alipay `time_expire` format `yyyy-MM-dd HH:mm:ss` in Asia/Shanghai. */
export function shanghaiDateTime(date: Date): string {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}
