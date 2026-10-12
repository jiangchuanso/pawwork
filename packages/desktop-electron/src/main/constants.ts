import { app } from "electron"
import { PAWWORK_APP, PAWWORK_RELEASE_OWNER, PAWWORK_UPDATE_CHANNEL, parsePawWorkChannel } from "./app-identity"

export const CHANNEL = parsePawWorkChannel(import.meta.env.OPENCODE_CHANNEL)

export const UPDATER_ACTIVE = app.isPackaged && CHANNEL === "prod"

// V2 uses its own updater pointer so v1 users are never upgraded across the
// migration boundary automatically. GitHub Releases is the only feed: this fork
// publishes nowhere else (see buildUpdateFeeds in index.ts).
export const UPDATE_CHANNEL = PAWWORK_UPDATE_CHANNEL
export const UPDATE_GITHUB_OWNER = PAWWORK_RELEASE_OWNER
export const UPDATE_GITHUB_REPO = PAWWORK_APP.prod.releaseRepo
