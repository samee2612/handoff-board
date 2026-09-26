import type { HandoffClaim, HandoffVersion } from "@/lib/contracts";

export type HandoffClaimChange = {
  kind: "added" | "removed";
  claim: HandoffClaim;
};

function claimKey(claim: HandoffClaim): string {
  return `${claim.section}\u0000${claim.text}`;
}

/**
 * Compares the evidence-supported text of two immutable versions. A changed sentence is
 * intentionally shown as one removal and one addition so no clinical meaning is inferred.
 */
export function compareHandoffVersions(published: HandoffVersion, candidate: HandoffVersion): HandoffClaimChange[] {
  const publishedClaims = new Map(published.claims.map((claim) => [claimKey(claim), claim]));
  const candidateClaims = new Map(candidate.claims.map((claim) => [claimKey(claim), claim]));
  return [
    ...candidate.claims.filter((claim) => !publishedClaims.has(claimKey(claim))).map((claim) => ({ kind: "added" as const, claim })),
    ...published.claims.filter((claim) => !candidateClaims.has(claimKey(claim))).map((claim) => ({ kind: "removed" as const, claim })),
  ];
}
