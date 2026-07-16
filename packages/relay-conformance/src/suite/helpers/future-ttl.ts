export function futureTtl(seconds = 3600): number {
  return Math.floor(Date.now() / 1000) + seconds;
}
