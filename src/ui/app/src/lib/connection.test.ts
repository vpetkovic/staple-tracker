import { describe, expect, it } from "vitest";
import { RECONNECTING_AFTER_MS, createConnectionTracker } from "./useStaple";

describe("whether the server is answering", () => {
  it("is live while polls are answered, however far apart they are", () => {
    const tracker = createConnectionTracker();
    tracker.attempted(0);
    tracker.answered();
    // A background tab can go a minute between polls; no poll was waiting meanwhile.
    expect(tracker.state(60_000)).toBe("live");
  });

  it("does not flash on one dropped poll, and says so once polls stay unanswered", () => {
    const tracker = createConnectionTracker();
    tracker.attempted(0);
    expect(tracker.state(1500)).toBe("live");
    tracker.attempted(1500);
    tracker.attempted(3000);
    expect(tracker.state(RECONNECTING_AFTER_MS - 1)).toBe("live");
    // Counted from the first unanswered attempt, not the latest.
    expect(tracker.state(RECONNECTING_AFTER_MS)).toBe("reconnecting");
  });

  it("counts a poll that hangs, with no answer to report itself", () => {
    const tracker = createConnectionTracker();
    tracker.attempted(1000);
    expect(tracker.state(1000 + RECONNECTING_AFTER_MS)).toBe("reconnecting");
  });

  it("is live again at the first answer", () => {
    const tracker = createConnectionTracker();
    tracker.attempted(0);
    expect(tracker.state(10_000)).toBe("reconnecting");
    tracker.answered();
    expect(tracker.state(10_001)).toBe("live");
    tracker.attempted(20_000);
    expect(tracker.state(20_000 + RECONNECTING_AFTER_MS - 1)).toBe("live");
  });
});
