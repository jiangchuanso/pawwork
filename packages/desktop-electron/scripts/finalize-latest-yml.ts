import { execFile } from "node:child_process"
import { access, mkdtemp, readFile as readTextFile, writeFile } from "node:fs/promises"
import path from "path"
import { promisify } from "node:util"
import { parseUpdaterMetadata } from "./updater-metadata"
import { METADATA_FILES, RELEASE_TARGETS } from "./release-targets"
import {
  ALLOW_REPUBLISH_ENV,
  decideFinalizeUpload,
  parseAllowRepublish,
  type ReleaseState,
} from "./release-republish-policy"
import { releaseProvenanceAssetName } from "./verify-release"

const execFileAsync = promisify(execFile)

const dir = process.env.LATEST_YML_DIR!
if (!dir) throw new Error("LATEST_YML_DIR is required")

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const repo = requireEnv("GH_REPO")

const version = process.env.OPENCODE_VERSION
if (!version) throw new Error("OPENCODE_VERSION is required")

type FileEntry = {
  url: string
  sha512: string
  size: number
  blockMapSize?: number
}

type LatestYml = {
  version: string
  files: FileEntry[]
  releaseDate: string
}

function parse(content: string): LatestYml {
  const metadata = parseUpdaterMetadata(content)
  const files = metadata.files.flatMap((file) =>
    file.sha512 !== undefined && file.size !== undefined
      ? [{ url: file.url, sha512: file.sha512, size: file.size, ...(file.blockMapSize === undefined ? {} : { blockMapSize: file.blockMapSize }) }]
      : [],
  )
  return { version: metadata.version ?? "", files, releaseDate: metadata.releaseDate ?? "" }
}

function serialize(data: LatestYml) {
  const lines = [`version: ${data.version}`, "files:"]
  for (const file of data.files) {
    lines.push(`  - url: ${file.url}`)
    lines.push(`    sha512: ${file.sha512}`)
    lines.push(`    size: ${file.size}`)
    if (file.blockMapSize) lines.push(`    blockMapSize: ${file.blockMapSize}`)
  }
  lines.push(`releaseDate: '${data.releaseDate}'`)
  return lines.join("\n") + "\n"
}

async function read(subdir: string, filename: string): Promise<LatestYml | undefined> {
  return await readFile(path.join(dir, subdir, filename))
}

async function readFile(filepath: string): Promise<LatestYml | undefined> {
  try {
    await access(filepath)
  } catch {
    return undefined
  }
  return parse(await readTextFile(filepath, "utf8"))
}

async function gh(args: string[]) {
  return await execFileAsync("gh", args)
}

function mergeLatest(...items: Array<LatestYml | undefined>): LatestYml | undefined {
  const present = items.filter((item): item is LatestYml => Boolean(item))
  if (present.length === 0) return undefined

  const files = new Map<string, FileEntry>()
  // On URL collision, later items overwrite earlier entries so live/current data wins.
  for (const item of present) {
    for (const file of item.files) files.set(file.url, file)
  }

  // Use the last item as the metadata base so fresh live releaseDate and version fields win over cached snapshots.
  const base = present.at(-1)!
  return {
    version: base.version,
    files: [...files.values()],
    releaseDate: base.releaseDate,
  }
}

function shellErrorText(error: unknown) {
  const parts: string[] = []
  if (error instanceof Error) parts.push(error.message)
  else parts.push(String(error))
  const maybe = error as { stdout?: unknown; stderr?: unknown }
  if (maybe.stderr) parts.push(String(maybe.stderr))
  if (maybe.stdout) parts.push(String(maybe.stdout))
  return parts.join("\n")
}

function isMissingAssetError(message: string) {
  // `gh release download` does not expose an asset-missing exit code, so keep this
  // narrow and let generic 404/release/repo/auth failures propagate.
  return /no assets to download|no matches found|no assets match|could not find any assets|release not found/i.test(
    message,
  )
}

function assertSameVersion(source: string, filename: string, data: LatestYml | undefined) {
  if (data && data.version !== version) {
    throw new Error(`Existing ${filename} from ${source} has version ${data.version}, expected ${version}`)
  }
  return data
}

async function downloadExisting(tag: string, filename: string) {
  const configured = process.env.EXISTING_LATEST_YML_DIR
  const cached = assertSameVersion(
    "EXISTING_LATEST_YML_DIR",
    filename,
    configured ? await readFile(path.join(configured, filename)) : undefined,
  )

  const liveDir = await mkdtemp(path.join(tmp, "live-latest-yml-"))
  try {
    await gh(["release", "download", tag, "--pattern", filename, "--dir", liveDir, "--repo", repo, "--clobber"])
  } catch (error) {
    const message = shellErrorText(error)
    if (isMissingAssetError(message)) return cached
    throw new Error(`Failed to download existing ${filename}: ${message}`)
  }
  const live = assertSameVersion("GitHub release", filename, await readFile(path.join(liveDir, filename)))
  return mergeLatest(cached, live)
}

// Guard the updater-metadata upload against an already-published release. In the
// normal flow the release stays a draft until the auto-publisher flips it at the
// very end; a published release here means either a later same-version build from
// a different commit (must fail closed) or an explicit same-version re-run with
// PAWWORK_RELEASE_ALLOW_REPUBLISH set (allowed to overwrite in place). The
// decision is a pure, unit-tested contract; when re-publishing we additionally
// refuse a different-commit clobber via the per-target provenance marker.
async function assertReleaseIsDraft(releaseTag: string) {
  const allowRepublish = parseAllowRepublish(process.env[ALLOW_REPUBLISH_ENV])
  let release: ReleaseState = null
  try {
    const { stdout } = await gh(["release", "view", releaseTag, "--json", "isDraft", "--jq", ".isDraft", "--repo", repo])
    release = { isDraft: stdout.trim() === "true" }
  } catch (error) {
    const message = shellErrorText(error)
    if (/release not found|not found/i.test(message)) release = null
    else throw new Error(`Failed to read release state for ${releaseTag}: ${message}`)
  }

  const decision = decideFinalizeUpload({ tag: releaseTag, release, allowRepublish })
  if (decision.action === "fail") {
    throw new Error(decision.reason)
  }
  if (release && !release.isDraft) {
    // Re-publishing into a live release: refuse a different-commit clobber. The
    // tag pins the build commit, so a same-version re-run is normally the same
    // commit; a re-run against a different ref must not rewrite the published
    // feed. The per-target provenance marker records the commit each target was
    // built from; if it disagrees with this build, stop.
    await refuseMismatchedSource(releaseTag)
    console.warn(`finalize-latest-yml: ${decision.reason}`)
  }
}

// When re-publishing into an already-published release, refuse to overwrite if a
// prior finalize left a provenance marker for THIS target built from a different
// commit. The published feed must never be pointed at installers from a commit
// other than the one the rest of the release was built from.
async function refuseMismatchedSource(releaseTag: string) {
  const buildSha = process.env.BUILD_SHA
  const os = process.env.RELEASE_OS
  const arch = process.env.RELEASE_ARCH
  if (!buildSha || !os || !arch) {
    // Without the provenance inputs we cannot guard; the publish step re-checks
    // single-source, so only warn rather than blocking the re-run.
    console.warn(
      "finalize-latest-yml: BUILD_SHA/RELEASE_OS/RELEASE_ARCH unset; skipping same-source guard (publish step will re-check)",
    )
    return
  }
  const version = releaseTag.replace(/^v/, "")
  const markerName = releaseProvenanceAssetName(os, arch, version)
  const dir = await mkdtemp(path.join(tmp, "published-marker-"))
  try {
    await gh(["release", "download", releaseTag, "--pattern", markerName, "--dir", dir, "--repo", repo])
  } catch {
    // No marker yet (this target never finalized against the published release):
    // nothing to compare against, so allow the first write.
    return
  }
  let marker: { commit?: string } | undefined
  try {
    marker = JSON.parse(await readTextFile(path.join(dir, markerName), "utf8"))
  } catch {
    // Malformed marker: treat as not-yet-present rather than blocking.
    return
  }
  if (marker?.commit && marker.commit !== buildSha) {
    throw new Error(
      `Release ${releaseTag} already has a ${markerName} marker built from ${marker.commit}, but this build is ${buildSha}; refusing to overwrite a published release built from a different commit`,
    )
  }
}

const output: Record<string, string> = {}
const tag = `v${version}`
const tmp = process.env.RUNNER_TEMP ?? "/tmp"

// One metadata file per updater feed, merged from every target that writes it —
// latest-v2-mac.yml carries arm64 and x64 together, latest-v2.yml carries Windows
// alone. Target order is the release matrix order, so the mac feed keeps arm64
// first and takes its version and date from that entry.
for (const metadata of METADATA_FILES) {
  const targets = RELEASE_TARGETS.filter((target) => target.metadata === metadata)
  const built = await Promise.all(targets.map((target) => read(target.metadataArtifact, metadata)))
  const present = built.filter((entry): entry is LatestYml => Boolean(entry))
  if (present.length === 0) continue
  output[metadata] = serialize(
    mergeLatest(await downloadExisting(tag, metadata), {
      version: present[0].version,
      files: present.flatMap((entry) => entry.files),
      releaseDate: present[0].releaseDate,
    })!,
  )
}

// Upload to release. Re-checked right before the writes to shrink the window
// between observing a draft and clobbering it.
await assertReleaseIsDraft(tag)
for (const [filename, content] of Object.entries(output)) {
  const filepath = path.join(tmp, filename)
  await writeFile(filepath, content)
  await gh(["release", "upload", tag, filepath, "--clobber", "--repo", repo])
  console.log(`uploaded ${filename}`)
}

console.log("finalized latest yml files")
