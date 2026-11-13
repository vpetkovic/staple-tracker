export function countWord(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function planCounts(ideas: number, members: number): string {
  return `${countWord(ideas, "idea")} · ${countWord(members, "member")}`;
}
