# Tools By DCX Chrome Extension (v2.4.7, Manifest V3)

Official extension for flow.toolsbydcx.com. Same working as the Bunny Flow
extension it is built from: it takes the shared Google Flow session from the
ToolsByDcx server and logs the user into Google Flow (Veo 3.1) and Nano
Banana with it, so the dashboard shows "Extension Connected" and
"Open Google Flow" opens Flow already logged in.

## Install (Chrome / Edge / Brave / Kiwi)
1. Download the ZIP from the Extension page on flow.toolsbydcx.com.
2. Extract it.
3. Open chrome://extensions, turn on Developer mode, click "Load unpacked",
   pick the extracted folder.

## How it works
- `portal-bridge.js` runs on flow.toolsbydcx.com, reads the website login
  (`flow_token` in localStorage), tells the background it is logged in, and
  answers the dashboard's connected checks and launch requests.
- `background.js` (service worker) fetches the shared session from
  `GET /api/extension/session?mode=video|image`, writes the Google cookies
  into the browser (`cookie-core.js` validates them first), and opens
  `https://flow.google.com/`.
- `flow-shield.js` / `content.js` run on Google Flow pages.
- `popup.html` shows the status and an Open Flow button.

The dashboard speaks the `BUNNYFLOW_*` window-message protocol and the
`flow_token` / `bf_device_id` keys. Those names are the protocol, not the
brand, so they are kept as-is on purpose.
