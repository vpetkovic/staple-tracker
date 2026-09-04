/**
 * Generate the Lucide glyph catalog from the INSTALLED `lucide-react` package.
 *
 *   npx tsx scripts/gen-lucide-catalog.ts
 *
 * Two checked-in modules come out of this:
 *
 *   src/ui/app/src/lib/icon-catalog.generated.ts   key → [category, ...aliases] — pure data;
 *                                                  labels, search terms, and the alias map
 *                                                  are derived from it in icon-catalog.ts
 *   src/ui/app/src/lib/icon-previews.generated.ts  one NAMED import per key from
 *                                                  `lucide-react`, mapped key → component
 *
 * The source of truth is `dist/esm/dynamicIconImports.mjs` inside the package: every
 * key Lucide ships, each pointing at the module that renders it. A key whose target
 * is itself is canonical; a key whose target is another module is an alias
 * (`alert-triangle` → `triangle-alert`). Aliases never become catalog keys — they
 * collapse onto the canonical key, are recorded on its entry, and their words feed
 * its search terms, because Lucide's aliases are its own synonym list
 * (`home` → `house`).
 *
 * The manifest stores the minimum — category and aliases per key — because the
 * main view will carry it (rows resolve persisted keys synchronously). Labels and
 * search terms are one string operation away and are rebuilt at load time.
 *
 * The package ships no tag or category metadata (that lives in the lucide monorepo),
 * so search terms are the words of the key and its aliases, and the category comes
 * from the ordered keyword table below: first table row that shares a word with the
 * key wins, then the same pass over alias words, then `other`. Deterministic, offline,
 * and the same answer on every machine with the same pinned version.
 *
 * "Every key resolves to a bundled icon" is proven by the previews module: a named
 * import that does not exist fails `npm run typecheck` and `npm run build:ui`, and
 * the map is typed `Record<IconKey, LucideIcon>` so a key without a component fails
 * the same way. `test/lucide-catalog-freshness.test.ts` fails if the checked-in text
 * drifts from what this script would write.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const LUCIDE_PACKAGE_DIR = join(REPO_ROOT, "node_modules", "lucide-react");
export const CATALOG_MODULE_PATH = join(REPO_ROOT, "src/ui/app/src/lib/icon-catalog.generated.ts");
export const PREVIEWS_MODULE_PATH = join(REPO_ROOT, "src/ui/app/src/lib/icon-previews.generated.ts");

export interface CatalogIcon {
  /** Lucide's canonical kebab-case name; the value STA-181 persists. */
  key: string;
  category: string;
  /** Lucide keys that render this same icon, sorted. Never catalog keys themselves. */
  aliases: string[];
}

export interface Catalog {
  version: string;
  categories: string[];
  /** Sorted by key. */
  icons: CatalogIcon[];
}

export const OTHER_CATEGORY = "other";

/**
 * Ordered: the first row sharing a word with the icon wins, so specific rows sit
 * above generic ones (`heart-pulse` is medical before it is social; `circle-check`
 * is status before it is a shape). Words must be whole kebab segments.
 */
export const CATEGORY_KEYWORDS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["accessibility", ["accessibility", "ear", "glasses", "braille", "wheelchair"]],
  ["brands", ["github", "gitlab", "codepen", "codesandbox", "chrome", "figma", "framer", "slack", "twitch", "twitter", "youtube", "facebook", "instagram", "linkedin", "dribbble", "trello", "pocket", "gitlab"]],
  ["medical", ["pulse", "stethoscope", "pill", "syringe", "bandage", "hospital", "dna", "brain", "bone", "tooth", "ambulance", "biohazard", "cross", "hearing", "cigarette", "medical", "wheat"]],
  ["science", ["omega", "phi", "tangent", "diameter", "radius", "angle", "radical", "divide", "equal", "calculator", "astroid", "galaxy", "eclipse", "zodiac", "space", "axis", "proportions", "ratio", "scaling", "atom", "flask", "microscope", "telescope", "test", "beaker", "magnet", "orbit", "radiation", "sigma", "pi", "infinity", "binary", "dna", "fossil", "planet", "earth"]],
  ["weather", ["sun", "moon", "cloud", "cloudy", "rain", "snow", "wind", "thermometer", "umbrella", "sunrise", "sunset", "tornado", "rainbow", "haze", "droplet", "droplets", "thunder", "snowflake", "fog", "drizzle", "hail", "lightning", "sunny"]],
  ["nature", ["flame", "fire", "rose", "stone", "dam", "recycle", "hop", "tree", "trees", "leaf", "leafy", "flower", "sprout", "mountain", "waves", "fish", "bird", "cat", "dog", "rabbit", "rat", "squirrel", "turtle", "snail", "shell", "shrub", "cactus", "clover", "palm", "trellis", "worm", "bug", "panda", "paw", "feather", "vegan", "origami", "egg", "seed"]],
  ["food", ["broccoli", "hamburger", "shrimp", "blender", "coffee", "pizza", "apple", "cake", "beer", "wine", "utensils", "cookie", "candy", "sandwich", "salad", "soup", "beef", "ham", "ice", "cup", "drumstick", "croissant", "donut", "cherry", "grape", "citrus", "banana", "carrot", "milk", "martini", "popcorn", "popsicle", "chef", "bean", "nut", "lollipop", "dessert", "cooking", "microwave", "refrigerator", "amphora", "bottle", "glass"]],
  ["home", ["blinds", "broom", "mop", "towel", "shelving", "rocking", "mirror", "wallpaper", "spray", "extinguisher", "parasol", "utility", "brick", "bed", "bath", "sofa", "lamp", "armchair", "oven", "washing", "fan", "heater", "vent", "door", "fence", "toilet", "plug", "power", "lightbulb", "lamp", "candle", "vacuum", "washer", "bathtub", "shower"]],
  ["buildings", ["building", "buildings", "house", "school", "church", "factory", "warehouse", "castle", "hotel", "store", "landmark", "tent", "university", "office", "campus", "bank", "prison", "lighthouse", "bridge"]],
  ["transportation", ["van", "scooter", "motorbike", "kayak", "ev", "trailer", "luggage", "baggage", "backpack", "car", "bus", "train", "plane", "bike", "ship", "truck", "tractor", "rocket", "fuel", "parking", "sailboat", "anchor", "taxi", "cable-car", "forklift", "tram", "caravan", "helicopter", "traffic", "wheel", "airplane", "railway", "highway", "route", "road"]],
  ["maps", ["map", "pin", "navigation", "compass", "globe", "locate", "signpost", "milestone", "waypoints", "flag", "land", "plot", "earth", "world", "location", "radar", "footprints"]],
  ["finance", ["lari", "riyal", "dollar", "euro", "pound", "yen", "bitcoin", "coins", "wallet", "credit", "banknote", "receipt", "piggy", "percent", "currency", "coin", "cent", "rupee", "lira", "franc", "shekel", "won", "ruble", "philippine", "peso", "hand-coins", "dinar", "dirham", "rial", "naira", "gem", "diamond"]],
  ["shopping", ["shopping", "cart", "bag", "tag", "tags", "gift", "package", "ticket", "tickets", "barcode", "qr", "scale", "basket", "shirt", "delivery", "handbag", "boxes", "container", "pallet", "weight"]],
  ["sports", ["trophy", "medal", "award", "dumbbell", "football", "volleyball", "goal", "target", "swords", "sword", "tennis", "bowling", "gym", "bicep", "run", "medal", "podium", "champion", "crown"]],
  ["gaming", ["gamepad", "dice", "dices", "joystick", "puzzle", "ghost", "spade", "club", "console", "chess", "game", "cards"]],
  ["security", ["lock", "unlock", "shield", "key", "keyhole", "fingerprint", "scan", "ban", "siren", "bomb", "skull", "eye-off", "incognito", "vault", "guard", "safe", "shredder"]],
  ["time", ["clock", "alarm", "calendar", "timer", "hourglass", "watch", "history", "stopwatch", "schedule", "date", "time", "range", "cake-slice", "birthday"]],
  ["development", ["code", "terminal", "git", "bug", "braces", "brackets", "database", "variable", "function", "regex", "hash", "blocks", "workflow", "webhook", "square-terminal", "commit", "branch", "merge", "pull", "fork", "compare", "graph", "json", "binary", "bot", "cpu", "chip", "dev", "console", "api", "curly", "parentheses", "ampersand", "asterisk", "percent", "command", "option", "shell", "bash", "script", "compile", "component", "puzzle", "package", "boxes", "block", "modules", "logs", "file-code", "toggle", "cog", "settings", "sliders"]],
  ["charts", ["chart", "pie", "trending", "activity", "gauge", "kanban", "sheet", "spreadsheet", "graph", "analytics", "candlestick", "scatter", "network", "radar", "stats"]],
  ["communication", ["mail", "mails", "mailbox", "message", "messages", "chat", "inbox", "send", "phone", "voicemail", "at-sign", "megaphone", "rss", "tower", "podcast", "mic", "speech", "announcement", "contact", "quote", "reply"]],
  ["media", ["turntable", "videotape", "metronome", "hd", "closed", "spotlight", "lens", "binoculars", "cctv", "midi", "hdmi", "presentation", "playing", "play", "pause", "stop", "music", "video", "film", "camera", "image", "images", "volume", "audio", "skip", "fast-forward", "rewind", "disc", "clapperboard", "tv", "gallery", "aperture", "focus", "cassette", "vinyl", "boom", "headphones", "headset", "radio", "youtube", "speaker", "guitar", "piano", "drum", "waveform", "airplay", "cast", "projector", "subtitles", "captions", "movie", "photo", "picture", "album"]],
  ["devices", ["gpu", "circuit", "sim", "touchpad", "vibrate", "drone", "robot", "charger", "calculator", "laptop", "monitor", "smartphone", "tablet", "keyboard", "mouse", "printer", "webcam", "router", "hard", "usb", "battery", "bluetooth", "wifi", "computer", "pc", "memory", "microchip", "cable", "ethernet", "satellite", "antenna", "remote", "cpu", "server", "drive", "gauge", "screen", "device", "flashlight", "watch", "nfc", "signal", "smartwatch", "phone", "charging", "sd"]],
  ["files", ["file", "files", "folder", "folders", "archive", "clipboard", "book", "books", "notebook", "document", "paperclip", "save", "import", "export", "library", "sticky", "note", "notepad", "scroll", "newspaper", "receipt", "pen-tool", "attachment", "copy", "paste", "scissors", "print", "printer", "bookmark", "album", "text", "page"]],
  ["text", ["ampersands", "copyright", "copyleft", "creative", "signature", "summary", "form", "type", "bold", "italic", "underline", "strikethrough", "heading", "list", "indent", "outdent", "letter", "case", "pilcrow", "spell", "subscript", "superscript", "whole", "word", "wrap", "a", "baseline", "ligature", "remove-formatting", "quote", "font", "spacing", "format", "highlighter", "language", "languages", "translate", "alphabet", "ordered", "unordered", "tree", "bullet", "numbers", "paragraph"]],
  ["design", ["palette", "brush", "paintbrush", "pen", "pencil", "pipette", "ruler", "crop", "layers", "frame", "eraser", "wand", "sparkles", "blend", "spline", "swatch", "paint", "bucket", "roller", "pipette", "vector", "bezier", "draw", "drafting", "color", "contrast", "shapes", "component", "stamp", "line", "pattern", "grip", "brackets"]],
  ["layout", ["layout", "grid", "columns", "rows", "panel", "panels", "sidebar", "align", "distribute", "split", "dock", "dashboard", "template", "gallery", "vertical", "horizontal", "justify", "spacing", "flex", "stretch", "fullscreen", "square-split", "table", "between", "app", "window", "section"]],
  ["tools", ["wrench", "hammer", "screwdriver", "settings", "cog", "sliders", "drill", "axe", "pickaxe", "shovel", "tool", "toolbox", "anvil", "construction", "hard-hat", "paint", "ruler", "magnet", "nut", "bolt", "gear", "pipette", "tape", "measure", "config", "cone", "fence"]],
  ["people", ["graduation", "lectern", "gavel", "vote", "party", "balloon", "ribbon", "venetian", "whistle", "biceps", "sport", "drama", "theater", "briefcase", "user", "users", "person", "baby", "contact", "smile", "frown", "meh", "laugh", "angry", "annoyed", "handshake", "hand", "thumbs", "face", "id", "badge", "venus", "mars", "male", "female", "gender", "transgender", "non-binary", "avatar", "profile", "group", "team", "community", "circle-user"]],
  ["connectivity", ["link", "unlink", "share", "network", "wifi", "bluetooth", "signal", "cast", "nfc", "cloud", "radio", "router", "antenna", "ethernet", "plug", "unplug", "connect", "sync", "upload", "download", "cloud-upload", "cloud-download", "server", "webhook", "broadcast", "hotspot"]],
  ["cursors", ["pointer", "grab", "cursor", "click", "tap", "select", "lasso", "text-cursor", "hand-pointer"]],
  ["interface", ["menu", "search", "plus", "minus", "trash", "delete", "eye", "view", "funnel", "eject", "timeline", "combine", "ungroup", "bring", "diff", "ad", "cannabis", "fishing", "birdhouse", "life"]],
  ["status", ["check", "x", "alert", "info", "help", "bell", "badge", "loader", "verified", "octagon", "triangle-alert", "circle-alert", "circle-check", "circle-x", "flag", "ban", "warning", "danger", "success", "question", "shield-check", "shield-alert", "shield-x", "circle-help", "circle-question", "circle-slash", "slash", "clock-alert", "loading", "spinner", "off", "on", "dot", "ellipsis", "more", "zap", "activity"]],
  ["shapes", ["tally", "sparkle", "slice", "squares", "crosshair", "sticker", "toy", "spool", "barrel", "bubbles", "circle", "square", "triangle", "hexagon", "octagon", "pentagon", "diamond", "star", "heart", "shape", "shapes", "rectangle", "oval", "cylinder", "cone", "pyramid", "torus", "box", "cuboid", "spline", "blend", "component", "dot", "sphere", "ellipse", "squircle", "cross", "ring", "asterisk", "hash", "circle-dashed", "square-dashed", "dashed", "dotted", "rounded"]],
  ["arrows", ["arrow", "arrows", "chevron", "chevrons", "move", "corner", "undo", "redo", "rotate", "refresh", "repeat", "shuffle", "iteration", "forward", "expand", "shrink", "maximize", "minimize", "fold", "unfold", "flip", "replace", "trending", "diagonal", "swap", "exchange", "return", "back", "next", "previous", "up", "down", "left", "right", "jump", "step", "loop", "cycle", "reload", "rewind", "external", "redirect", "sort", "merge", "split", "collapse", "extend", "log-in", "log-out", "in", "out"]],
];

/** Split a kebab key into its words. */
export function keyWords(key: string): string[] {
  return key.split("-").filter((word) => word.length > 0);
}

/** `triangle-alert` → `TriangleAlert`, Lucide's own component-name rule. */
export function componentNameFor(key: string): string {
  return keyWords(key)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

function matchCategory(words: string[], key: string): string | undefined {
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    for (const keyword of keywords) {
      if (keyword.includes("-") ? key.includes(keyword) : words.includes(keyword)) return category;
    }
  }
  return undefined;
}

export function categoryFor(key: string, aliases: string[]): string {
  const own = matchCategory(keyWords(key), key);
  if (own !== undefined) return own;
  for (const alias of aliases) {
    const viaAlias = matchCategory(keyWords(alias), alias);
    if (viaAlias !== undefined) return viaAlias;
  }
  return OTHER_CATEGORY;
}

/** Read the version and the key → module map straight from the installed package. */
export function readInstalledLucide(packageDir = LUCIDE_PACKAGE_DIR): {
  version: string;
  imports: Map<string, string>;
} {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { version: string };
  const source = readFileSync(join(packageDir, "dist/esm/dynamicIconImports.mjs"), "utf8");
  const imports = new Map<string, string>();
  for (const match of source.matchAll(/"([a-z0-9-]+)": \(\) => import\('\.\/icons\/([a-z0-9-]+)\.mjs'\)/g)) {
    imports.set(match[1] as string, match[2] as string);
  }
  if (imports.size === 0) {
    throw new Error(`no dynamic icon imports found in ${packageDir} — has the lucide-react layout changed?`);
  }
  return { version: pkg.version, imports };
}

export function buildCatalog(packageDir = LUCIDE_PACKAGE_DIR): Catalog {
  const { version, imports } = readInstalledLucide(packageDir);
  const aliasesByCanonical = new Map<string, string[]>();
  for (const [key, target] of [...imports].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (key === target) {
      if (!aliasesByCanonical.has(key)) aliasesByCanonical.set(key, []);
      continue;
    }
    if (imports.get(target) !== target) {
      throw new Error(`alias ${key} points at ${target}, which is not a canonical icon`);
    }
    aliasesByCanonical.set(target, [...(aliasesByCanonical.get(target) ?? []), key]);
  }
  const icons: CatalogIcon[] = [...aliasesByCanonical]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, aliases]) => ({ key, category: categoryFor(key, aliases), aliases: [...aliases].sort() }));
  return {
    version,
    categories: [...CATEGORY_KEYWORDS.map(([category]) => category), OTHER_CATEGORY],
    icons,
  };
}

export function aliasCount(catalog: Catalog): number {
  return catalog.icons.reduce((n, icon) => n + icon.aliases.length, 0);
}

const header = (catalog: Catalog, what: string, ...notes: string[]) => `/**
 * GENERATED — do not edit by hand.
 * Regenerate with: npx tsx scripts/gen-lucide-catalog.ts
 *
 * ${what} for lucide-react ${catalog.version}: ${catalog.icons.length} canonical icons,
 * ${aliasCount(catalog)} aliases collapsed onto them.${notes.map((note) => `\n *\n * ${note}`).join("")}
 */`;

export function catalogModuleSource(catalog: Catalog): string {
  const entries = catalog.icons
    .map((icon) => `  ${JSON.stringify(icon.key)}: ${JSON.stringify([icon.category, ...icon.aliases])},`)
    .join("\n");
  return `${header(catalog, "Searchable manifest")}

export const LUCIDE_VERSION = ${JSON.stringify(catalog.version)};

export const ICON_CATEGORIES = ${JSON.stringify(catalog.categories)} as const;

export type IconCategory = (typeof ICON_CATEGORIES)[number];

/** Canonical key → [category, ...aliases]. Keys are sorted; an alias is never a key. */
export const ICON_MANIFEST = {
${entries}
} as const satisfies Record<string, readonly [IconCategory, ...string[]]>;

export type IconKey = keyof typeof ICON_MANIFEST;
`;
}

export function previewsModuleSource(catalog: Catalog): string {
  const names = catalog.icons.map((icon) => `  ${componentNameFor(icon.key)},`).join("\n");
  const entries = catalog.icons
    .map((icon) => `  ${JSON.stringify(icon.key)}: ${componentNameFor(icon.key)},`)
    .join("\n");
  return `${header(
    catalog,
    "Preview components",
    "Only ever reach this module through \`import()\` (see \`loadIconComponent\` in\n" +
      " * icon-catalog.ts): it names every icon, so wherever it is imported statically,\n" +
      " * every icon ships. A missing export here fails typecheck and build — that is\n" +
      " * the proof that every catalog key resolves to a bundled icon.",
  )}
import {
${names}
  type LucideIcon,
} from "lucide-react";
import type { IconKey } from "./icon-catalog.generated";

export const ICON_COMPONENTS: Readonly<Record<IconKey, LucideIcon>> = {
${entries}
};
`;
}

function main(): void {
  const catalog = buildCatalog();
  writeFileSync(CATALOG_MODULE_PATH, catalogModuleSource(catalog), "utf8");
  process.stdout.write(`wrote ${CATALOG_MODULE_PATH}\n`);
  writeFileSync(PREVIEWS_MODULE_PATH, previewsModuleSource(catalog), "utf8");
  process.stdout.write(`wrote ${PREVIEWS_MODULE_PATH}\n`);
  const counts = new Map<string, number>();
  for (const icon of catalog.icons) counts.set(icon.category, (counts.get(icon.category) ?? 0) + 1);
  process.stdout.write(
    `lucide-react ${catalog.version}: ${catalog.icons.length} icons, ${aliasCount(catalog)} aliases; ` +
      [...counts].map(([category, n]) => `${category} ${n}`).join(", ") +
      "\n",
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
