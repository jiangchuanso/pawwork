// Policy for re-uploading artifacts and updater metadata into an ALREADY
// published release — a same-version re-run of a failed or torn release
// (e.g. the draft was published by an earlier run before every target landed).
//
// Default (no opt-in): an already-published release is treated as frozen. A
// later build from a different commit must never rewrite its installers or
// updater feeds, so finalize fails closed. This is the existing fail-closed
// behavior, preserved so a normal run is unchanged.
//
// Opt-in via PAWWORK_RELEASE_ALLOW_REPUBLISH: a same-version re-run may
// overwrite a published release in place. The flag only makes sense against an
// EXISTING release — you cannot "re-publish" a release that does not exist (that
// is just a normal run) — so setting it when none exists is a misconfiguration
// and fails closed too.

// Single source of truth for the opt-in flag's name. The release workflow sets
// this exact variable, and a contract test pins the two together, so a rename or
// typo on either side cannot silently disable the switch — a mismatch makes
// finalize read `undefined` and fail closed, which looks like "opt-in did nothing".
export const ALLOW_REPUBLISH_ENV = "PAWWORK_RELEASE_ALLOW_REPUBLISH"

export type ReleaseState = { isDraft: boolean } | null

export type FinalizeUploadDecision =
  | { action: "upload"; reason: string }
  | { action: "fail"; reason: string }

export function parseAllowRepublish(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes" || value === "on"
}

// Pure decision for whether finalize-latest-yml may re-upload updater metadata
// into a release. Kept free of I/O so the fail-closed contract is unit-testable.
export function decideFinalizeUpload(args: {
  tag: string
  release: ReleaseState
  allowRepublish: boolean
}): FinalizeUploadDecision {
  const { tag, release, allowRepublish } = args

  // No release yet. Normally electron-builder creates the draft and the upload
  // lands there; "re-publish into nothing" is meaningless, so treat the flag as
  // a misconfiguration rather than silently doing a normal run.
  if (!release) {
    if (allowRepublish) {
      return {
        action: "fail",
        reason: `PAWWORK_RELEASE_ALLOW_REPUBLISH is set but release ${tag} does not exist; re-runs republish into an existing release, so use a normal run instead`,
      }
    }
    return { action: "upload", reason: `no release for ${tag} yet; electron-builder will create the draft` }
  }

  if (release.isDraft) {
    return { action: "upload", reason: `reusing draft for ${tag}` }
  }

  // Release is already published.
  if (!allowRepublish) {
    return {
      action: "fail",
      reason: `Release ${tag} is already published; refusing to overwrite its updater metadata from a later build`,
    }
  }
  return {
    action: "upload",
    reason: `release ${tag} is already published and PAWWORK_RELEASE_ALLOW_REPUBLISH is set; re-uploading updater metadata into the live release`,
  }
}
