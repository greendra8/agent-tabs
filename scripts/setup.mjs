// Creates (or with --rotate, replaces) the broker token and copies it into the extension folder.
// After rotating, reload the extension in chrome://extensions and restart the broker.

import { ensureToken, extensionId, TOKEN_FILE } from "../broker/token.mjs";

const rotate = process.argv.includes("--rotate");
ensureToken({ rotate });
console.log(`${rotate ? "Rotated" : "Token ready"}: ${TOKEN_FILE} (copied to extension/token.json)`);
console.log(`Extension id: ${extensionId()}`);
