#!/usr/bin/env node
// Mints a fresh GitHub App installation access token and prints it to
// stdout, nothing else. Used two ways: directly by the gh-CLI background
// refresh loop in docker-entrypoint.sh, and imported as the core of
// github-app-git-credential-helper.mjs. Never caches to disk —
// every invocation mints a genuinely fresh token, valid ~1h per GitHub's
// own (non-configurable) installation-token lifetime.
import { createAppAuth } from "@octokit/auth-app";
import { readFileSync } from "node:fs";

export async function mintInstallationToken() {
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;

  if (!appId || !installationId || !privateKeyPath) {
    throw new Error(
      "GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and GITHUB_APP_PRIVATE_KEY_PATH must all be set"
    );
  }

  const privateKey = readFileSync(privateKeyPath, "utf8");
  const auth = createAppAuth({ appId, privateKey, installationId });
  const { token } = await auth({ type: "installation" });
  return token;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mintInstallationToken()
    .then((token) => process.stdout.write(token + "\n"))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
