import { describe, expect, it } from "vitest";
import { landingRequests, requestLanding, subscribeLandingRequests } from "./landing-requests";

describe("landing requests", () => {
  it("counts each request and tells every listener, until it unsubscribes", () => {
    const start = landingRequests();
    const heard: number[] = [];
    const stop = subscribeLandingRequests(() => heard.push(landingRequests()));
    requestLanding();
    requestLanding();
    expect(landingRequests()).toBe(start + 2);
    expect(heard).toEqual([start + 1, start + 2]);
    stop();
    requestLanding();
    expect(heard).toEqual([start + 1, start + 2]);
    expect(landingRequests()).toBe(start + 3);
  });
});
