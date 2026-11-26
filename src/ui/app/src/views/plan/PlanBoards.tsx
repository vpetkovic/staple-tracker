/**
 * The Ideas and Horizons lenses' names, where other files and tests have always imported them.
 * The code lives beside it: `IdeasLens.tsx`, `HorizonsLens.tsx`, the shared board shell in
 * `plan-board.tsx` and the presentational parts in `plan-parts.tsx`.
 */
export { IdeasBoard, shelfRestore } from "./IdeasLens";
export { AddHorizon, HorizonMenuItem, HorizonsBoard } from "./HorizonsLens";
export { cardMenuItems, type Write } from "./plan-board";
export { Chip, DeliveryChips, HorizonChip, planIncomplete, Progress } from "./plan-parts";
