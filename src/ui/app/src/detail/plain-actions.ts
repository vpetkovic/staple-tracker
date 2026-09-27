/**
 * The detail's verbs in plain words.
 *
 * The tracker and its agents speak in checkouts, releases and status ids (`blocked`,
 * `in_progress`). A person opening a task on their phone needs to know what a button does to
 * the task, not what the command is called. The command names are not hidden — they sit under
 * "Show details" beside the buttons — they are just not the labels.
 */
export const ACTION_WORDS = {
  /** Applies the status picked in the menu beside it. */
  status: "Change status",
  /** `checkout`: somebody is now working on this task. */
  checkout: "Start working on it",
  checkoutPrompt: "Who is working on it? Type your name or the agent's name.",
  /** `release`: nobody is working on it any more; it goes back to be picked up. */
  release: "Stop working on it",
  /** `checkout` with steal: the holder went quiet and someone else takes it. */
  takeOver: "Take it over",
  takeOverPrompt: (holder: string) => `${holder} has gone quiet. Who is taking this over? Type your name or the agent's name.`,
  /** `release` of a silent holder's claim. */
  releaseStale: "Free it up",
} as const;

/**
 * What the status menu offers: the workspace's own vocabulary in its configured order, or the
 * built-in statuses before settings have loaded — and always the task's current status, so the
 * menu can show what the task is even when the vocabulary does not list it.
 */
export function statusChoices(configured: readonly string[], builtIn: readonly string[], current: string): string[] {
  const base = configured.length > 0 ? [...configured] : [...builtIn];
  return base.includes(current) ? base : [current, ...base];
}
