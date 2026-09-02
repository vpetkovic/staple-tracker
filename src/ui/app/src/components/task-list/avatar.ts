/**
 * Initials for the two avatars on a row — V5 (STA-97) §7.3.
 *
 * ONE helper for both the working pill's agent and the assignee human, on purpose. If the
 * agent avatar said `OX` for `opus-x` and the assignee avatar said `O`, the row would be
 * telling the reader that those two circles come from different systems. They do not.
 *
 * The shape difference between agent and human — rounded square vs circle — is carried in
 * CSS, not here, and it is deliberately a SHAPE rather than a tint: it survives greyscale,
 * it survives 18px, it costs nothing from a palette that is otherwise monochrome, and it
 * is the convention GitHub already taught everyone with organisations vs users.
 */

/**
 * `opus-x` → `OX` · `v5-designer` → `VD` · `VP` → `VP` · `claude` → `CL`
 *
 * Two tokens take one letter each; one token takes its first two letters. The hard cap is
 * the point — an unbounded "first letter of every token" turns `some-long-agent-name` into
 * four characters and bursts an 18px circle.
 */
export function initials(name: string): string {
  const tokens = name.trim().split(/[^a-z0-9]+/i).filter(Boolean);
  if (tokens.length === 0) return "??";
  const raw =
    tokens.length >= 2
      ? `${tokens[0]!.slice(0, 1)}${tokens[1]!.slice(0, 1)}`
      : tokens[0]!.slice(0, 2);
  return raw.toUpperCase().slice(0, 2);
}
