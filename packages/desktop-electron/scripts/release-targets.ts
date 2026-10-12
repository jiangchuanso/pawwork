import { PAWWORK_UPDATE_CHANNEL } from "../src/main/app-identity.ts"

// One statement of what a PawWork release ships. Every script that names a
// release asset, an updater metadata file or a per-target CI artifact derives it
// from here. Before, the verifier, the auto-publisher, the metadata finalizer and
// the download mirror each restated a different slice of the same matrix, and
// build.yml restated it a fifth time.
export const RELEASE_TARGETS = [
  {
    os: "mac",
    arch: "arm64",
    installerExt: "dmg",
    updaterExt: "zip",
    metadata: `${PAWWORK_UPDATE_CHANNEL}-mac.yml`,
    // Rust-triple names, because that is what the CI artifacts are keyed by.
    metadataArtifact: "latest-yml-aarch64-apple-darwin",
    blockmap: true,
  },
  {
    os: "mac",
    arch: "x64",
    installerExt: "dmg",
    updaterExt: "zip",
    metadata: `${PAWWORK_UPDATE_CHANNEL}-mac.yml`,
    metadataArtifact: "latest-yml-x86_64-apple-darwin",
    blockmap: true,
  },
  {
    os: "win",
    arch: "x64",
    installerExt: "exe",
    updaterExt: "exe",
    metadata: `${PAWWORK_UPDATE_CHANNEL}.yml`,
    metadataArtifact: "latest-yml-x86_64-pc-windows-msvc",
    blockmap: true,
  },
  {
    os: "linux",
    arch: "arm64",
    installerExt: "deb",
    updaterExt: "deb",
    // electron-builder does not emit blockmaps for deb packages, so none is
    // expected in the release or the updater metadata.
    blockmap: false,
    // Not the x64 spelling: app-builder-lib's getUpdateInfoFileName appends
    // `-${arch}` on Linux for every non-x64 arch, and electron-updater's
    // getChannelFilePrefix derives the same name client-side, so the arm64
    // feed is `latest-<channel>-linux-arm64.yml` at both ends. Naming it
    // `latest-v2-linux.yml` here made CI copy a file electron-builder never
    // writes and would publish a feed no client ever requests.
    metadata: `${PAWWORK_UPDATE_CHANNEL}-linux-arm64.yml`,
    metadataArtifact: "latest-yml-aarch64-unknown-linux-gnu",
  },
] as const

export type ReleaseTarget = (typeof RELEASE_TARGETS)[number]
export type MetadataFile = ReleaseTarget["metadata"]

// Targets a release deliberately ships WITHOUT, as "<os>-<arch>" keys, e.g.
// "mac-arm64,mac-x64". Set while a platform cannot be built at all — currently
// macOS, which needs the Apple Developer ID signing certificate (CSC_LINK) and
// notarization credentials. Unset/empty means every target below must ship.
function excludedTargetKeys(): Set<string> {
  const raw = process.env.PAWWORK_RELEASE_EXCLUDE_TARGETS
  if (!raw) return new Set()
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
}

function targetKey(target: { os: string; arch: string }) {
  return `${target.os}-${target.arch}`
}

// The targets a complete release must contain. Every script that names a release
// asset, an updater metadata file or a provenance marker derives from THIS list,
// so a deliberately dropped platform is not reported as a "missing target".
// Without this, publish-when-complete.ts waits forever for a target that can
// never arrive and the release stays a draft.
const EXCLUDED_TARGETS = excludedTargetKeys()
export const EXPECTED_RELEASE_TARGETS = RELEASE_TARGETS.filter(
  (target) => !EXCLUDED_TARGETS.has(targetKey(target)),
)

export const METADATA_FILES: MetadataFile[] = [...new Set(EXPECTED_RELEASE_TARGETS.map((target) => target.metadata))]

export function releaseAssetName(target: { os: string; arch: string }, version: string, ext: string) {
  return `pawwork-${target.os}-${target.arch}-${version}.${ext}`
}

export function releaseTarget(os: string, arch: string): ReleaseTarget {
  const target = RELEASE_TARGETS.find((entry) => entry.os === os && entry.arch === arch)
  if (!target) throw new Error(`unsupported release target: ${os}-${arch}`)
  return target
}
