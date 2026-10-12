import { describe, expect, test } from "vitest"

import { decideFinalizeUpload, parseAllowRepublish, type ReleaseState } from "./release-republish-policy"

const TAG = "v2026.9.13"
const draft: ReleaseState = { isDraft: true }
const published: ReleaseState = { isDraft: false }

describe("parseAllowRepublish", () => {
  test("treats empty / unset as off", () => {
    expect(parseAllowRepublish(undefined)).toBe(false)
    expect(parseAllowRepublish("")).toBe(false)
    expect(parseAllowRepublish("false")).toBe(false)
  })

  test("treats the accepted truthy spellings as on", () => {
    expect(parseAllowRepublish("true")).toBe(true)
    expect(parseAllowRepublish("1")).toBe(true)
    expect(parseAllowRepublish("yes")).toBe(true)
    expect(parseAllowRepublish("on")).toBe(true)
  })
})

describe("decideFinalizeUpload", () => {
  test("normal flow: uploads into a draft", () => {
    expect(decideFinalizeUpload({ tag: TAG, release: draft, allowRepublish: false }).action).toBe("upload")
    expect(decideFinalizeUpload({ tag: TAG, release: draft, allowRepublish: true }).action).toBe("upload")
  })

  test("normal flow: fails closed on an already-published release (no opt-in)", () => {
    const decision = decideFinalizeUpload({ tag: TAG, release: published, allowRepublish: false })
    expect(decision.action).toBe("fail")
    expect(decision.reason).toContain("already published")
  })

  test("opt-in: uploads into an already-published release", () => {
    const decision = decideFinalizeUpload({ tag: TAG, release: published, allowRepublish: true })
    expect(decision.action).toBe("upload")
    expect(decision.reason).toContain("PAWWORK_RELEASE_ALLOW_REPUBLISH")
  })

  test("opt-in with no release is a misconfiguration and fails closed", () => {
    const decision = decideFinalizeUpload({ tag: TAG, release: null, allowRepublish: true })
    expect(decision.action).toBe("fail")
    expect(decision.reason).toContain("does not exist")
  })

  test("no release without opt-in proceeds (electron-builder will create the draft)", () => {
    expect(decideFinalizeUpload({ tag: TAG, release: null, allowRepublish: false }).action).toBe("upload")
  })
})
