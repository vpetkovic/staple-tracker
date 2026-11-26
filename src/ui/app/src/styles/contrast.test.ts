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

// And only the `.dark { … }` blocks: what dark mode overrides.
const darkRoot = [...geist.matchAll(/^\.dark\s*\{([^}]*)\}/gm)].map((m) => m[1]).join("\n");

function hexOf(name: string, sheet: string = lightRoot): string {
  const scale = (key: string) => new RegExp(`${key}:\\s*(#[0-9a-f]{6})`, "i").exec(sheet)?.[1];
  const raw = new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(sheet)?.[1]?.trim() ?? "";
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

describe("dark-mode text contrast", () => {
  const CARD = rgb("#1f1f1f"); // --ds-gray-200, the dark card
  const RAIL = rgb("#1a1a1a"); // --ds-gray-100, the dark rail

  it("dark mode says its own muted and tertiary text, AA on the card and the rail, muted AA at 80%", () => {
    const muted = rgb(hexOf("--muted-foreground", darkRoot));
    const tertiary = rgb(hexOf("--text-tertiary", darkRoot));
    for (const bg of [CARD, RAIL]) {
      expect(ratio(muted, bg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(tertiary, bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(over(muted, CARD, 0.8), CARD)).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * The plan's flags: text in a hue on a tag tinted with that hue at 12% (16% for the amber),
 * over a card or a sunken surface, in both themes. The text tokens live in system-tokens.css.
 */
describe("plan flag contrast", () => {
  const system = readFileSync(fileURLToPath(new URL("./system-tokens.css", import.meta.url)), "utf8");
  const systemLight = system.replace(/^\.dark\s*\{[^}]*\}/gm, "");
  const systemDark = [...system.matchAll(/^\.dark\s*\{([^}]*)\}/gm)].map((m) => m[1]).join("\n");
  // A flag token is a hex, or a Geist scale step resolved in the same theme.
  const flag = (name: string, dark: boolean) => {
    const raw = new RegExp(`${name}:\\s*([^;]+);`).exec(dark ? systemDark : systemLight)?.[1]?.trim() ?? "";
    const ref = /var\((--[a-z0-9-]+)\)/.exec(raw)?.[1];
    return rgb(ref ? hexOf(ref, dark ? darkRoot : lightRoot) : raw);
  };
  const themes = [
    { dark: false, surfaces: [WHITE, SUNKEN], hues: { late: "--ds-red-700", todo: "--ds-amber-700", you: "--ds-blue-700" } },
    // The dark card, and the sunken well 18% black over it.
    { dark: true, surfaces: [rgb("#1f1f1f"), rgb("#191919")], hues: { late: "--ds-red-700", todo: "--ds-amber-700", you: "--ds-blue-700" } },
  ] as const;

  for (const theme of themes) {
    it(`late, not started and needs you are AA on their own tint in ${theme.dark ? "dark" : "light"} mode`, () => {
      for (const [tone, hue] of Object.entries(theme.hues)) {
        const tint = rgb(hexOf(hue, theme.dark ? darkRoot : lightRoot));
        const text = flag(`--flag-${tone}`, theme.dark);
        for (const surface of theme.surfaces) {
          expect(ratio(text, over(tint, surface, tone === "todo" ? 0.16 : 0.12)), `${tone} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});
