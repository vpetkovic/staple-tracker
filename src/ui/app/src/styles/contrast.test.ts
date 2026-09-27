/**
 * The text tiers clear WCAG AA (4.5:1) on every light surface the desk shell puts them on —
 * computed from the token sheets themselves, so a value edit that drops below AA fails here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const geist = readFileSync(fileURLToPath(new URL("./geist-tokens.css", import.meta.url)), "utf8");
// Every `.dark { … }` block removed: what is left is the light theme.
const lightRoot = geist.replace(/^\.dark\s*\{[^}]*\}/gm, "");

function hexOf(name: string): string {
  const scale = (key: string) => new RegExp(`${key}:\\s*(#[0-9a-f]{6})`, "i").exec(lightRoot)?.[1];
  const raw = new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(lightRoot)?.[1]?.trim() ?? "";
  const ref = /var\((--[a-z0-9-]+)\)/.exec(raw)?.[1];
  const hex = ref ? scale(ref) : raw;
  expect(hex, name).toMatch(/^#[0-9a-f]{6}$/i);
  return hex!;
}
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (c: number[]) => {
  const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
};
const ratio = (fg: number[], bg: number[]) => {
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a! + 0.05) / (b! + 0.05);
};
const over = (fg: number[], bg: number[], alpha: number) => fg.map((v, i) => v * alpha + bg[i]! * (1 - alpha));

const WHITE = rgb("#ffffff");
const SIDEBAR = rgb("#f2f2f2"); // --ds-gray-100, the rail
const SUNKEN = rgb("#f6f6f6"); // --surface-sunken on a white card

describe("light-mode text contrast", () => {
  it("tertiary text (rail labels, counts, the find field's placeholder) is AA on the rail, a sunken field and a card", () => {
    const tertiary = rgb(hexOf("--text-tertiary"));
    for (const bg of [WHITE, SIDEBAR, SUNKEN]) expect(ratio(tertiary, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("muted text is AA solid, and still AA where it is drawn at 80% (hints)", () => {
    const muted = rgb(hexOf("--muted-foreground"));
    for (const bg of [WHITE, SIDEBAR]) expect(ratio(muted, bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(over(muted, WHITE, 0.8), WHITE)).toBeGreaterThanOrEqual(4.5);
  });
});
