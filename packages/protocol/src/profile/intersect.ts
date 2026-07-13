export function intersectProfiles(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const profile of a) {
    if (setB.has(profile) && !seen.has(profile)) {
      seen.add(profile);
      result.push(profile);
    }
  }
  return result.sort();
}
