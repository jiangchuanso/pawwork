// Site-level constants.
//
// DOWNLOAD holds the download targets: this fork publishes GitHub Releases only
// and has no download mirror, so every button points at its own Releases page and
// the visitor picks the installer. There is deliberately no R2 manifest swap any
// more — the only manifest that exists is the upstream project's, and pointing
// this page's buttons at another repository's builds would hand visitors a
// different app than the one this site describes.

export const REPO_URL = "https://github.com/jiangchuanso/pawwork";
export const RELEASES_URL = `${REPO_URL}/releases/latest`;

export const DOWNLOAD = {
  mac: RELEASES_URL,
  macIntel: RELEASES_URL,
  win: RELEASES_URL,
  linux: RELEASES_URL,
};
