import { useEffect, useState } from "react";
import { ladderWidth, rowPlan, samePlan, type RowPlan } from "./row-layout";

function readPlan(): RowPlan {
  const media = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia.bind(window) : null;
  return rowPlan(ladderWidth(media ? (min) => media(`(min-width: ${min}px)`).matches : null));
}

/**
 * The row plan for the current viewport, re-read on resize. A resize that crosses no rung
 * keeps the same object, so the list does not re-render for it.
 */
export function useRowPlan(): RowPlan {
  const [plan, setPlan] = useState(readPlan);
  useEffect(() => {
    const onResize = () =>
      setPlan((previous) => {
        const next = readPlan();
        return samePlan(previous, next) ? previous : next;
      });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return plan;
}
