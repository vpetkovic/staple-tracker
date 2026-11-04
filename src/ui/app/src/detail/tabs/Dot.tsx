/**
 * The separator between two facts on one line: " · " with REAL spaces, so the line reads
 * "moved to Backlog · just now" when it is copied, selected or read aloud, not
 * "Backlog·just now". The dot itself is decoration and is hidden from screen readers; the
 * spaces around it are kept outside the hidden span so the words never run together.
 */
export function Dot() {
  return (
    <>
      {" "}
      <span aria-hidden className="text-text-tertiary">
        ·
      </span>{" "}
    </>
  );
}
