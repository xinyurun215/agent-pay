/** China Standard Time is a fixed UTC+8 offset (no daylight saving). */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function shanghaiDate(date: Date): string {
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}
