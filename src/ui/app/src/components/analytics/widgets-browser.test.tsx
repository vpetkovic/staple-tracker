/// <reference lib="dom" />
/**
 * The widgets in a real browser: keyboard, screen-reader wiring, clicks, touch sizes, forced
 * colours and reduced motion. The markup tests beside each widget pin what it draws; this pins
 * what it does when a person presses a key, taps it, or has asked the system for more contrast
 * or less motion.
 *
 * `widgets.fixture.tsx` is bundled with esbuild and mounted in Chromium over the app's own built
 * stylesheet, so the Tailwind classes, the house base layer (the 44px touch floor) and
 * `analytics.css` are the real ones.
 *
 * SKIPPED, SAYING WHY, when there is no built UI bundle or no Chromium for `playwright-core`
 * (the same rule as test/ui-queue-keyboard.test.ts; in CI it must run).
 */
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const cache = process.platform === "darwin" ? join(userInfo().homedir, "Library", "Caches", "ms-playwright") : join(userInfo().homedir, ".cache", "ms-playwright");
  if (existsSync(cache)) process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
}

const { chromium } = await import("playwright-core");

const DIST = fileURLToPath(new URL("../../../dist/", import.meta.url));
const APP_SRC = fileURLToPath(new URL("../../", import.meta.url));

async function chromiumAvailable(): Promise<boolean> {
  try {
    const probe = await chromium.launch();
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

const bundle = existsSync(join(DIST, "index.html"));
const browserReady = bundle && (await chromiumAvailable());
const reason = !bundle ? "no UI bundle (run npm run build:ui)" : !browserReady ? "no Chromium for playwright-core" : "";
if (reason) console.warn(`widgets-browser: skipped — ${reason}`);
if (reason && process.env.CI) {
  describe("widgets-browser: a browser to run in", () => {
    it("has the UI bundle and Chromium", () => {
      throw new Error(`widgets-browser cannot run in CI: ${reason}.`);
    });
  });
}

let browser: Browser;
let html: string;
let script: string;

beforeAll(async () => {
  if (reason) return;
  const index = readFileSync(join(DIST, "index.html"), "utf8");
  const sheet = /href="\.?\/?(assets\/[^"]+\.css)"/.exec(index)?.[1];
  if (!sheet) throw new Error("the UI bundle's index.html names no stylesheet");
  const css = readFileSync(join(DIST, sheet), "utf8");
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./widgets.fixture.tsx", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: { "@": APP_SRC },
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty" },
    logLevel: "silent",
  });
  script = out.outputFiles[0]!.text;
  html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style></head><body class="bg-background text-foreground"><div id="root"></div></body></html>`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

const DESK: BrowserContextOptions = { viewport: { width: 1000, height: 1600 } };
const TOUCH: BrowserContextOptions = { viewport: { width: 1000, height: 1600 }, isMobile: true, hasTouch: true };

async function open(options: BrowserContextOptions = DESK): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html);
  await page.addScriptTag({ content: script });
  await page.locator('[data-chart="columns"]').waitFor();
  // Whether the widget handled a key: one it does not own must not be swallowed.
  await page.evaluate(() => {
    const seen: { key: string; prevented: boolean }[] = [];
    (window as unknown as { keys: typeof seen }).keys = seen;
    window.addEventListener("keydown", (event) => seen.push({ key: event.key, prevented: event.defaultPrevented }));
  });
  return { page, context, errors };
}

async function withPage(options: BrowserContextOptions, run: (page: Page) => Promise<void>): Promise<void> {
  const { page, context, errors } = await open(options);
  try {
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}

/** Two animation frames: every event the last input sent has run, and React has drawn its result. */
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const events = (page: Page) => page.evaluate(() => (window as unknown as { widgetEvents: string[] }).widgetEvents);
const keys = (page: Page) => page.evaluate(() => (window as unknown as { keys: { key: string; prevented: boolean }[] }).keys);

describe.skipIf(Boolean(reason))("the column chart from the keyboard", () => {
  it("walks the slots with Left, Right, Home and End, says each once in the live region, and Escape clears", async () => {
    await withPage(DESK, async (page) => {
      const plot = page.getByRole("img", { name: "Hours per day: 14 h in total." });
      const tooltip = page.locator("[data-chart-tooltip]");
      const readout = page.locator("[data-chart-readout]");
      await plot.focus();
      expect(await tooltip.count()).toBe(0);
      expect(await readout.textContent()).toBe("");

      await page.keyboard.press("ArrowRight");
      expect(await readout.textContent()).toBe("Nov 1: 2 h Staple; 2 h Total");
      expect(await tooltip.innerText()).toContain("Nov 1");
      await page.keyboard.press("ArrowRight");
      expect(await readout.textContent()).toBe("Nov 2: 1 h Staple, 3 h Docs; 4 h Total");
      await page.keyboard.press("End");
      expect(await readout.textContent()).toBe("Nov 3: 6 h Staple, 2 h Docs; 8 h Total");
      await page.keyboard.press("ArrowRight");
      expect(await readout.textContent()).toBe("Nov 3: 6 h Staple, 2 h Docs; 8 h Total");
      await page.keyboard.press("Home");
      expect(await readout.textContent()).toBe("Nov 1: 2 h Staple; 2 h Total");
      await page.keyboard.press("ArrowLeft");
      expect(await readout.textContent()).toBe("Nov 1: 2 h Staple; 2 h Total");
      await page.keyboard.press("Escape");
      expect(await tooltip.count()).toBe(0);
      expect(await readout.textContent()).toBe("");
      // With nothing active, Escape is left for whatever the chart sits in.
      await page.keyboard.press("Escape");
      await page.keyboard.press("Tab");

      expect(await keys(page)).toEqual([
        ...["ArrowRight", "ArrowRight", "End", "ArrowRight", "Home", "ArrowLeft", "Escape"].map((key) => ({ key, prevented: true })),
        { key: "Escape", prevented: false },
        { key: "Tab", prevented: false },
      ]);
    });
  });

  it("is read once: the tooltip is hidden from assistive technology and the live region sits outside the image", async () => {
    await withPage(DESK, async (page) => {
      await page.getByRole("img", { name: "Hours per day: 14 h in total." }).focus();
      await page.keyboard.press("ArrowRight");
      const wiring = await page.evaluate(() => {
        const tooltip = document.querySelector("[data-chart-tooltip]");
        const readout = document.querySelector("[data-chart-readout]");
        return {
          tooltipHidden: tooltip?.closest('[aria-hidden="true"]') !== null,
          tooltipRole: tooltip?.getAttribute("role") ?? null,
          live: readout?.getAttribute("aria-live"),
          readoutInsideImage: readout?.closest('[role="img"]') !== null,
          liveRegions: document.querySelectorAll('[data-chart="columns"] [aria-live], [data-chart="columns"] [role="status"]').length,
        };
      });
      expect(wiring).toEqual({ tooltipHidden: true, tooltipRole: null, live: "polite", readoutInsideImage: false, liveRegions: 1 });
    });
  });

  it("shows the same readout on hover as on focus, and clears it when the pointer leaves", async () => {
    await withPage(DESK, async (page) => {
      const tooltip = page.locator("[data-chart-tooltip]");
      await page.getByRole("img", { name: "Hours per day: 14 h in total." }).focus();
      await page.keyboard.press("End");
      const byKey = await tooltip.innerText();
      await page.keyboard.press("Escape");
      await page.locator('[data-slot-index="2"]').hover();
      expect(await tooltip.innerText()).toBe(byKey);
      expect(await page.locator("[data-chart-readout]").textContent()).toBe("Nov 3: 6 h Staple, 2 h Docs; 8 h Total");
      await page.mouse.move(990, 1590);
      expect(await tooltip.count()).toBe(0);
    });
  });
});

describe.skipIf(Boolean(reason))("the column chart on a touch screen", () => {
  it("keeps the readout of a tapped slot until the reader taps elsewhere", async () => {
    await withPage(TOUCH, async (page) => {
      const readout = page.locator("[data-chart-readout]");
      // A tap ends with the touch pointer leaving the plot (pointerup, then pointerout and
      // pointerleave). Read each state only after that has run and React has drawn it, so a
      // readout the leave clears is caught every time rather than by chance.
      await page.locator('[data-slot-index="2"]').tap();
      await settled(page);
      expect(await page.locator("[data-chart-tooltip]").count()).toBe(1);
      expect(await readout.textContent()).toBe("Nov 3: 6 h Staple, 2 h Docs; 8 h Total");
      await page.locator('[data-slot-index="0"]').tap();
      await settled(page);
      expect(await readout.textContent()).toBe("Nov 1: 2 h Staple; 2 h Total");
      await page.getByText("Agents worked 14 hours.").tap();
      await settled(page);
      expect(await page.locator("[data-chart-tooltip]").count()).toBe(0);
    });
  });
});

describe.skipIf(Boolean(reason))("the heatmap on a touch screen", () => {
  it("keeps the readout of a tapped cell until the reader taps elsewhere", async () => {
    await withPage(TOUCH, async (page) => {
      const readout = page.locator('[data-chart="heatmap"] [aria-live="polite"]');
      const active = page.locator('[data-chart="heatmap"] [data-active]');
      await page.locator('[data-chart="heatmap"] [data-mark]').first().tap();
      await settled(page);
      expect(await active.count()).toBe(1);
      expect(await readout.innerText()).toBe("0 tickets · Mon 12 am");
      await page.getByText("Agents worked 14 hours.").tap();
      await settled(page);
      expect(await active.count()).toBe(0);
      expect(await readout.innerText()).toBe("Busiest hour: 10 tickets");
    });
  });
});

describe.skipIf(Boolean(reason))("the heatmap from the keyboard", () => {
  it("moves the active cell with the arrows, Home and End, says it in the readout, and Escape clears", async () => {
    await withPage(DESK, async (page) => {
      const readout = page.locator('[data-chart="heatmap"] [aria-live="polite"]');
      const active = page.locator('[data-chart="heatmap"] [data-active]');
      await page.getByRole("img", { name: "Tickets closed by weekday and hour" }).focus();
      expect(await readout.innerText()).toBe("Busiest hour: 10 tickets");
      await page.keyboard.press("ArrowRight");
      expect(await readout.innerText()).toBe("0 tickets · Mon 12 am");
      await page.keyboard.press("ArrowRight");
      expect(await readout.innerText()).toBe("1 tickets · Mon 1 am");
      await page.keyboard.press("ArrowDown");
      expect(await readout.innerText()).toBe("3 tickets · Tue 1 am");
      await page.keyboard.press("End");
      expect(await readout.innerText()).toBe("0 tickets · Tue 2 am");
      await page.keyboard.press("Home");
      expect(await readout.innerText()).toBe("10 tickets · Tue 12 am");
      await page.keyboard.press("ArrowUp");
      expect(await readout.innerText()).toBe("0 tickets · Mon 12 am");
      expect(await active.count()).toBe(1);
      await page.keyboard.press("Escape");
      expect(await active.count()).toBe(0);
      expect(await readout.innerText()).toBe("Busiest hour: 10 tickets");
      expect((await keys(page)).every((key) => key.prevented)).toBe(true);
    });
  });
});

describe.skipIf(Boolean(reason))("every control from the keyboard", () => {
  it("each chart is one tab stop, and every stop has an accessible name and a visible focus ring", async () => {
    await withPage(DESK, async (page) => {
      const stops: { name: string; ring: string; inChart: boolean }[] = [];
      for (let index = 0; index < 40; index += 1) {
        await page.keyboard.press("Tab");
        const stop = await page.evaluate(() => {
          const element = document.activeElement as HTMLElement | null;
          if (!element || element === document.body) return null;
          const style = getComputedStyle(element);
          return {
            name: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim(),
            // The house focus-ring is a 2px outline; the shared help toggle draws a 2px ring (a box-shadow).
            ring: style.outlineStyle === "solid" && style.outlineWidth === "2px" ? "outline" : style.boxShadow !== "none" ? "ring" : `none (${style.outlineStyle} ${style.outlineWidth})`,
            inChart: element.parentElement?.closest('[role="img"]') !== null,
          };
        });
        if (!stop) break;
        stops.push(stop);
      }
      const names = stops.map((stop) => stop.name);
      expect(names.filter((name) => name === "Hours per day: 14 h in total.")).toHaveLength(1);
      expect(names.filter((name) => name === "Tickets closed by weekday and hour")).toHaveLength(1);
      expect(names).toContain("Show Hours per day as a table");
      expect(names.some((name) => name.includes("Open the Return lens"))).toBe(true);
      expect(names).toContain("Show all 10 features");
      expect(names).toContain("Try again");
      for (const stop of stops) {
        expect(stop.name, JSON.stringify(stop)).not.toBe("");
        expect(stop.ring, stop.name).toBe(stop.name === "What does this mean?" ? "ring" : "outline");
        expect(stop.inChart, stop.name).toBe(false);
      }
    });
  });
});

describe.skipIf(Boolean(reason))("clicks", () => {
  it("the Table switch swaps the chart for its table and back", async () => {
    await withPage(DESK, async (page) => {
      const widget = page.getByRole("region", { name: "Hours per day" });
      const toggle = widget.getByRole("button", { name: "Show Hours per day as a table" });
      expect(await toggle.getAttribute("aria-pressed")).toBe("false");
      await toggle.click();
      const back = widget.getByRole("button", { name: "Show Hours per day as a chart" });
      expect(await back.getAttribute("aria-pressed")).toBe("true");
      expect(await widget.locator('[data-chart="columns"]').count()).toBe(0);
      expect(await widget.locator("table tbody tr").count()).toBe(3);
      expect(await widget.locator("table thead").innerText()).toContain("Staple");
      await back.click();
      expect(await widget.locator('[data-chart="columns"]').count()).toBe(1);
      expect(await widget.locator("table").count()).toBe(0);
    });
  });

  it("a stat tile in button mode calls onOpen on a click and on Enter", async () => {
    await withPage(DESK, async (page) => {
      const tile = page.getByRole("button", { name: /Open the Return lens/ });
      await tile.click();
      await tile.focus();
      await page.keyboard.press("Enter");
      expect(await events(page)).toEqual(["open-return", "open-return"]);
    });
  });

  it("Show all reveals every feature, Show fewer folds them back, and a title opens its ref", async () => {
    await withPage(DESK, async (page) => {
      const table = page.locator('[data-chart="features"]');
      expect(await table.locator("li").count()).toBe(8);
      await page.getByRole("button", { name: "Show all 10 features" }).click();
      expect(await table.locator("li").count()).toBe(10);
      const fewer = page.getByRole("button", { name: "Show fewer" });
      expect(await fewer.getAttribute("aria-expanded")).toBe("true");
      await fewer.click();
      expect(await table.locator("li").count()).toBe(8);
      await page.getByRole("button", { name: "Feature 2", exact: true }).click();
      expect(await events(page)).toEqual(["open:STA-2"]);
    });
  });

  it("Try again calls the widget's retry", async () => {
    await withPage(DESK, async (page) => {
      await page.getByRole("button", { name: "Try again" }).click();
      expect(await events(page)).toEqual(["retry"]);
    });
  });
});

describe.skipIf(Boolean(reason))("on a touch screen", () => {
  /** Each button's drawn box and its tap box (the box grown by an absolutely placed ::before). */
  const measure = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll("main button")].map((element) => {
        const box = element.getBoundingClientRect();
        const before = getComputedStyle(element, "::before");
        const grown = before.content !== "none" && before.position === "absolute";
        const inset = (value: string) => (grown ? Number.parseFloat(value) || 0 : 0);
        return {
          name: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim(),
          height: box.height,
          tapHeight: box.height - inset(before.top) - inset(before.bottom),
          tapWidth: box.width - inset(before.left) - inset(before.right),
        };
      }),
    );

  it("every control keeps its desk size and grows an invisible tap area of at least 32px", async () => {
    let desk: Awaited<ReturnType<typeof measure>> = [];
    await withPage(DESK, async (page) => {
      desk = await measure(page);
    });
    await withPage(TOUCH, async (page) => {
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      const touch = await measure(page);
      expect(touch.map((button) => button.name)).toEqual(desk.map((button) => button.name));
      expect(touch.map((button) => button.name)).toEqual(expect.arrayContaining(["Show Hours per day as a table", "What does this mean?", expect.stringContaining("Open the Return lens"), "Feature 1", "Show all 10 features", "Try again"]));
      touch.forEach((button, index) => {
        expect(button.height, button.name).toBe(desk[index]?.height);
        expect(button.tapHeight, button.name).toBeGreaterThanOrEqual(32);
        expect(button.tapWidth, button.name).toBeGreaterThanOrEqual(32);
      });
    });
  });
});

describe.skipIf(Boolean(reason))("forced colours", () => {
  const paint = (page: Page) =>
    page.evaluate(() => {
      const style = (selector: string) => getComputedStyle(document.querySelector(selector) as Element);
      return {
        segment: style('[data-chart="columns"] [data-slot-index="2"] [data-mark]').backgroundColor,
        heatCell: style('[data-chart="heatmap"] .viz-heat-5').backgroundColor,
        part: style('[data-chart="segments"] [data-mark]').backgroundColor,
        bar: style('[data-chart="bars"] [data-mark]').backgroundColor,
        band: style('[data-chart="return-range"] [data-mark]').backgroundColor,
        trackOutline: style('[data-chart="bars"] [data-track]').outlineStyle,
        gridline: style("[data-gridline]").backgroundColor,
        canvas: getComputedStyle(document.body).backgroundColor,
        // A fill that is not a mark: the UA repaints it, which is what the marks are kept from.
        sunken: style('[data-slot="skeleton"]').backgroundColor,
        // Another component's data-mark and data-active outside any chart.
        outsider: style("[data-outsider]").backgroundColor,
        outsiderOutline: style("[data-outsider]").outlineStyle,
      };
    });

  it("keeps every mark's own colour, outlines tracks and draws gridlines in a system colour", async () => {
    let normal: Awaited<ReturnType<typeof paint>> | undefined;
    await withPage(DESK, async (page) => {
      normal = await paint(page);
    });
    await withPage({ ...DESK, forcedColors: "active" }, async (page) => {
      expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
      const forced = await paint(page);
      // The emulation really repaints: an ordinary fill changes.
      expect(forced.sunken).not.toBe(normal?.sunken);
      expect(forced.segment).toBe(normal?.segment);
      expect(forced.heatCell).toBe(normal?.heatCell);
      expect(forced.part).toBe(normal?.part);
      expect(forced.bar).toBe(normal?.bar);
      expect(forced.band).toBe(normal?.band);
      expect(normal?.trackOutline).toBe("none");
      expect(forced.trackOutline).toBe("solid");
      // Repainted as Canvas a gridline would vanish into the page; it is drawn in GrayText.
      expect(forced.gridline).not.toBe(forced.canvas);
      expect(forced.gridline).not.toBe("rgba(0, 0, 0, 0)");
      // The rules stop at the widgets' roots.
      expect(forced.outsider).not.toBe(normal?.outsider);
      expect(forced.outsiderOutline).toBe("none");
    });
  });

  it("outlines the active slot and cell in Highlight", async () => {
    await withPage({ ...DESK, forcedColors: "active" }, async (page) => {
      await page.getByRole("img", { name: "Tickets closed by weekday and hour" }).focus();
      await page.keyboard.press("ArrowRight");
      expect(await page.locator('[data-chart="heatmap"] [data-active]').evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
      await page.locator('[data-slot-index="1"]').hover();
      expect(await page.locator('[data-chart="columns"] [data-active]').evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
    });
  });
});

describe.skipIf(Boolean(reason))("reduced motion", () => {
  const motion = (page: Page) =>
    page.evaluate(() => {
      const arrow = document.querySelector('button[data-slot="stat-tile"] svg') as Element;
      return {
        skeletons: [...document.querySelectorAll('[data-slot="skeleton"]')].map((element) => getComputedStyle(element).animationName),
        arrowTransition: getComputedStyle(arrow).transitionDuration,
      };
    });

  it("stops the skeleton pulse and the tile arrow's nudge, which play otherwise", async () => {
    await withPage(DESK, async (page) => {
      const moving = await motion(page);
      // Three in the loading tile, two in the loading widget.
      expect(moving.skeletons).toHaveLength(5);
      expect(moving.skeletons.every((name) => name !== "none")).toBe(true);
      expect(moving.arrowTransition).not.toBe("0s");
      await page.getByRole("button", { name: /Open the Return lens/ }).hover();
      await expect.poll(() => page.locator('button[data-slot="stat-tile"] svg').first().evaluate((element) => getComputedStyle(element).translate)).not.toBe("none");
    });
    await withPage({ ...DESK, reducedMotion: "reduce" }, async (page) => {
      const still = await motion(page);
      expect(still.skeletons.every((name) => name === "none")).toBe(true);
      expect(still.arrowTransition).toBe("0s");
      await page.getByRole("button", { name: /Open the Return lens/ }).hover();
      expect(await page.locator('button[data-slot="stat-tile"] svg').first().evaluate((element) => getComputedStyle(element).translate)).toBe("none");
    });
  });
});
