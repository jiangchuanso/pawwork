import { describe, expect, test } from "vitest"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ALLOW_REPUBLISH_ENV } from "./release-republish-policy"

// A unit test cannot prove what a shell workflow does — only that a step whose
// absence would ship an unverified or incomplete build is still there, and still
// ordered correctly. These read the workflow as steps rather than as text, so a
// reformat inside a step does not fail them and a deleted step does.
const workflow = readFileSync(join(import.meta.dirname, "..", "..", "..", ".github", "workflows", "build.yml"), "utf8")
const publisher = readFileSync(join(import.meta.dirname, "publish-when-complete.ts"), "utf8")
const finalizer = readFileSync(join(import.meta.dirname, "finalize-latest-yml.ts"), "utf8")

const steps = workflow
  .split(/\n {6}- name: /)
  .slice(1)
  .map((block) => ({ name: block.split("\n")[0].trim(), body: block }))

function stepsRunning(pattern: RegExp) {
  return steps.filter((step) => pattern.test(step.body))
}

function indexOfStep(name: string) {
  return steps.findIndex((step) => step.name === name)
}

function conditionOfStep(name: string) {
  const condition = steps[indexOfStep(name)]?.body.match(/\n {8}if: (?<condition>.+)/)?.groups?.condition
  if (!condition) throw new Error(`step "${name}" has no if: condition`)
  return condition
}

function runSourceValidation(phase: string, githubRef: string, sourceRef = "") {
  const match = workflow.match(
    /- name: Validate release source branch\n\s+run: \|\n(?<script>(?: {10}.*\n|\n)+?)\s+env:/,
  )
  if (!match?.groups?.script) throw new Error("release source validation step is missing")

  return spawnSync("bash", ["-c", match.groups.script.replace(/^ {10}/gm, "")], {
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_SOURCE_REF: "main",
      GITHUB_REF: githubRef,
      PHASE: phase,
      SOURCE_REF: sourceRef,
    },
  })
}

describe("release workflow", () => {
  test("accepts main branch submit and finalize sources", () => {
    expect(runSourceValidation("submit", "refs/heads/main").status).toBe(0)
    expect(runSourceValidation("finalize", "refs/tags/workflow-snapshot-1", "main").status).toBe(0)
  })

  test("rejects release sources outside main", () => {
    expect(runSourceValidation("submit", "refs/heads/dev").status).toBe(1)
    expect(runSourceValidation("finalize", "refs/tags/workflow-snapshot-1", "dev").status).toBe(1)
  })

  // This fork ships GitHub Releases only. The publisher used to hand the
  // published release to an R2 mirror; that workflow is gone, so anything here
  // still dispatching it would fail the publish step of a release that had in
  // fact published correctly.
  test("publishes without dispatching a download mirror", () => {
    expect(publisher).not.toMatch(/mirror-release-to-r2/)
    expect(publisher).not.toMatch(/gh workflow run|dispatchMirror/)
    expect(workflow).not.toContain("mirror-release-to-r2")
    expect(workflow).not.toContain("MIRROR_REF")
    // Only the tag-push orchestrator needs to dispatch a workflow.
    expect(workflow.match(/actions: write/g) ?? []).toHaveLength(1)
  })

  // A tag push for a version whose release is already published is a re-publish.
  // Only the orchestrator can know that, so it has to detect the live release and
  // forward the opt-in the build jobs gate on — otherwise a re-pushed tag keeps
  // failing closed, which is exactly the "re-running a torn release is
  // impossible" failure this pins down.
  test("forwards the republish opt-in when the pushed tag's release is already published", () => {
    const detect = stepsRunning(/releases\/tags/)
    expect(detect.map((step) => step.name)).toEqual(["Detect an already-published release"])
    // The step writes its decision to the `allow-republish` output (dash form in
    // the workflow YAML) so the dispatch step can forward it verbatim — that is
    // the only channel by which a re-pushed tag reaches the build jobs' gate.
    expect(detect[0].body).toMatch(/allow-republish=\$allow_republish/)
    expect(detect[0].body).toMatch(/'\.draft'/)

    const dispatch = steps.find((step) => /gh workflow run build\.yml/.test(step.body))
    expect(dispatch).toBeDefined()
    expect(dispatch!.body).toMatch(/-f allow_republish="\$ALLOW_REPUBLISH"/)
    expect(dispatch!.body).toMatch(/ALLOW_REPUBLISH: \$\{\{ steps\.release_state\.outputs\.allow-republish \}\}/)
  })

  // electron-builder creates the release when the tag has none and uploads a
  // target's assets concurrently, so without a claimed draft the first phase to
  // publish for a tag can split its assets across two of them.
  test("claims one release draft before any step uploads assets", () => {
    const ensure = indexOfStep("Ensure a single release draft")
    expect(ensure).toBeGreaterThanOrEqual(0)
    expect(steps[ensure].body).toMatch(/ensure-release-draft\.ts/)
    // Every target that uploads to the release has to claim the draft, and only
    // those: the same gate the metadata finalizer runs under, word for word.
    expect(conditionOfStep("Ensure a single release draft")).toBe(conditionOfStep("Finalize updater metadata"))

    const publishing = stepsRunning(/electron-builder .*--publish always/)
    expect(publishing.map((step) => step.name)).toEqual(["Package notarized artifacts"])
    for (const step of publishing) expect(steps.indexOf(step)).toBeGreaterThan(ensure)
    // Windows resolves --publish through a variable, so it is ordered by name.
    expect(indexOfStep("Package app")).toBeGreaterThan(ensure)
  })

  test("release lookup refuses a split tag instead of reading half of one", () => {
    expect(publisher).toContain("duplicateReleasesMessage(tag, matches)")
  })

  test("bundles uv and Python before anything packages the app", () => {
    const packaging = stepsRunning(/electron-builder .*(--mac|\$\{\{ matrix\.platform_flag \}\})/)
    // submit packs the signed directory, finalize repacks it into dmg/zip, and
    // Windows packs in one go.
    expect(packaging.map((step) => step.name)).toEqual([
      "Package signed app",
      "Package notarized artifacts",
      "Package app",
    ])

    const prepare = indexOfStep("Prepare uv and bundled Python")
    expect(prepare).toBeGreaterThanOrEqual(0)
    for (const step of packaging) expect(steps.indexOf(step)).toBeGreaterThan(prepare)
    expect(steps[prepare].body).toMatch(/prepare-uv\.ts/)
    expect(steps[prepare].body).toMatch(/prepare-primary-runtime\.ts/)
    expect(steps[prepare].body).toMatch(/uv_platform="darwin"/)
    expect(steps[prepare].body).toMatch(/uv_platform="win32"/)
  })

  test("keeps the two-phase notarization split intact", () => {
    // Packing a fresh bundle in the finalize phase would discard the notarized
    // one; --prepackaged is what makes the shipped dmg the stapled build.
    const submit = steps[indexOfStep("Package signed app")]
    const finalize = steps[indexOfStep("Package notarized artifacts")]
    // A distributable target makes electron-builder write app-update.yml into
    // the bundle before signing; the dir-only target deliberately skips it.
    expect(submit.body).toMatch(/electron-builder --mac zip .*--publish never/)
    expect(finalize.body).toMatch(/electron-builder --mac dmg zip .*--prepackaged "\$APP_PATH"/)
  })

  test("verifies the notarized bundle's signature and updater target in both artifacts", () => {
    const verify = steps[indexOfStep("Verify notarized artifacts")]
    expect(verify.body).toMatch(/codesign --verify --deep --strict/)
    // The zip and the dmg are packed separately, so both copies are checked.
    expect(verify.body).toMatch(/verify_app_update_config "\$verify_dir\//)
    expect(verify.body).toMatch(/verify_app_update_config "\$mounted_app\//)
    expect(verify.body).toMatch(/grep -qx "repo: \$PUBLISH_REPO"/)
    expect(verify.body).toMatch(/grep -qx "channel: latest-v2"/)
  })

  test("installs and smokes a production Windows installer before upload without signing infrastructure", () => {
    const pack = indexOfStep("Package app")
    const install = indexOfStep("Verify and install Windows package")
    const smoke = indexOfStep("Smoke installed Windows package")
    const upload = indexOfStep("Upload packaged app artifact")

    expect(pack).toBeGreaterThanOrEqual(0)
    expect(install).toBeGreaterThan(pack)
    expect(smoke).toBeGreaterThan(install)
    expect(upload).toBeGreaterThan(smoke)
    expect(steps[install].body).toMatch(/latest-v2/)
    expect(steps[smoke].body).toMatch(/ci-smoke\.ts packaged prod/)
    expect(workflow).not.toMatch(/azure\/login|AZURE_|Get-AuthenticodeSignature|signtoolOptions/)
  })

  // The finalizer merges the other arch's entries into this channel's feed, so
  // the repository it reads from and the one it writes to have to be the same
  // one — reading metadata from the wrong release into this feed puts an
  // unrelated sha512 under the live pointer and updater verification fails.
  test("finalizes updater metadata in the repository the build publishes to", () => {
    const finalize = steps.find((step) => /finalize-latest-yml\.ts/.test(step.body))
    const predownload = steps[indexOfStep("Download existing updater metadata")]
    expect(finalize).toBeDefined()
    expect(finalize!.body).toMatch(/inputs\.channel != 'dev'/)
    expect(finalize!.body).toMatch(/GH_REPO: \$\{\{ env\.PUBLISH_OWNER \}\}\/\$\{\{ env\.PUBLISH_REPO \}\}/)
    expect(predownload.body).toMatch(/--repo "\$PUBLISH_OWNER\/\$PUBLISH_REPO"/)
    expect(predownload.body).toMatch(/inputs\.channel != 'dev'/)
    // Dev builds write no updater metadata, so collecting it runs only where finalizing does.
    expect(conditionOfStep("Collect updater metadata")).toBe(conditionOfStep("Finalize updater metadata"))

    // One notion of "the release repository" in every step that touches it: the
    // draft claim, the metadata finalizer and the auto-publisher must all read
    // and write the repository PAWWORK_RELEASE_OWNER names, never
    // github.repository (the fork that happens to be running the workflow) —
    // pointing the two at different repositories silently verifies one release
    // and publishes another.
    for (const name of ["Ensure a single release draft", "Publish release when all targets are complete"]) {
      expect(steps[indexOfStep(name)].body).toMatch(/GH_REPO: \$\{\{ env\.PUBLISH_OWNER \}\}\/\$\{\{ env\.PUBLISH_REPO \}\}/)
    }
    expect(workflow).not.toMatch(/GH_REPO: \$\{\{ github\.repository \}\}/)
  })

  // Linux joined the release matrix without being added to the publisher, so its
  // provenance marker was never written and the auto-publisher waited forever
  // for a target that could never arrive.
  test("publishes for every non-macOS target that finalizes updater metadata", () => {
    const condition = conditionOfStep("Publish release when all targets are complete")
    expect(condition).toMatch(/runner\.os == 'Windows'/)
    expect(condition).toMatch(/runner\.os == 'Linux'/)
    expect(condition).toMatch(/inputs\.phase == 'full'/)
  })

  // The republish opt-in is read from the environment, so the name finalize reads
  // has to be the name the workflow exports. A typo on either side makes finalize
  // see `undefined`, which fails closed — the switch silently does nothing while
  // the job still errors on the published release, exactly the confusing failure
  // this pins down.
  test("wires the republish opt-in to the exact flag finalize reads", () => {
    expect(workflow).toContain(ALLOW_REPUBLISH_ENV + ": ${{ inputs.allow_republish }}")
    expect(finalizer).toContain("process.env[ALLOW_REPUBLISH_ENV]")
  })
})
