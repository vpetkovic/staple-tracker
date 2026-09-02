import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn's class merger. Every ui/ primitive expects to find it here. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
