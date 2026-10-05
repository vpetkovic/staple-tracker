/**
 * A base64 evidence document as task details first draws it.
 *
 * Static render, like tabs.test.tsx: no effects run, so no bytes are fetched.
 * What it pins is the verdict a reader meets. A verified document says so and
 * offers a download. A mismatch is an alert that names the problem, and it never
 * gets an image.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DocumentEvidence } from "@/lib/types";
import { EvidenceDocument } from "./EvidenceDocument";

const verified: DocumentEvidence = {
  status: "verified",
  declaredMediaType: "image/png",
  declaredSha256: "a".repeat(64),
  mediaType: "image/png",
  sha256: "a".repeat(64),
  size: 94398,
  problem: null,
  filename: "evidence-before.png",
};

function draw(evidence: DocumentEvidence): string {
  return renderToStaticMarkup(
    <EvidenceDocument
      workspace="ai-inbox-supabase"
      issueRef="AII-2"
      docKey="evidence-before-png"
      revision={1}
      evidence={evidence}
      name="Evidence before png"
      body={"# AII-2 BEFORE screenshot\n\nMedia type: image/png\n"}
    />,
  );
}

describe("EvidenceDocument", () => {
  it("says a verified file is verified and offers it, with the raw text folded away", () => {
    const html = draw(verified);
    expect(html).toContain('data-evidence-document="verified"');
    expect(html).toContain("SHA-256 verified");
    expect(html).toContain("Download");
    expect(html).not.toContain('role="alert"');
    expect(html).toMatch(/<details[^>]*>.*Raw document text/s);
    expect(html).not.toMatch(/<details[^>]*open/);
  });

  it("flags a mismatch, names the problem, and draws no image", () => {
    const html = draw({
      ...verified,
      status: "sha256_mismatch",
      sha256: "b".repeat(64),
      problem: "The bytes hash to bbbb, not the SHA-256 this document claims.",
    });
    expect(html).toContain('data-evidence-document="sha256_mismatch"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Not verified");
    expect(html).toContain("The bytes hash to bbbb");
    expect(html).not.toContain("SHA-256 verified");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Download");
  });
});
