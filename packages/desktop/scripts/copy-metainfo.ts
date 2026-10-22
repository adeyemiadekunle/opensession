import { resolveChannel } from "./utils"

const arg = process.argv[2]

const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = channel === "prod" ? "dev.opensession.desktop" : `dev.opensession.desktop.${channel}`

const productName = channel === "prod" ? "OpenSession" : `OpenSession ${channel.charAt(0).toUpperCase() + channel.slice(1)}`

const summary = `AI coding agent, on your computer or in the cloud${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="dev.opensession">
    <name>OpenSession</name>
  </developer>

  <description>
    <p>
      OpenSession is an AI coding agent built on OpenCode. Bring your own model API key and run it
      in your project folder or in a private cloud sandbox.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">https://github.com/adeyemiadekunle/opensession/issues</url>
  <url type="homepage">https://github.com/adeyemiadekunle/opensession</url>
  <url type="vcs-browser">https://github.com/adeyemiadekunle/opensession</url>

</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)

console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
