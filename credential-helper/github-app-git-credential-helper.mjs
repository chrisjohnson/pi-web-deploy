#!/usr/bin/env node
// Git credential helper (M-132): implements the protocol git expects
// (`git config credential.helper '/path/to/this get'`) — reads key=value
// pairs on stdin (ignored; we always return the same installation-scoped
// credential regardless of host/path), writes username/password to
// stdout. `store`/`erase` are no-ops: the token is freshly minted per
// invocation, never written to disk by git itself, so there's nothing to
// store or erase.
import { mintInstallationToken } from "./github-app-token.mjs";

const action = process.argv[2];
if (action !== "get") {
  process.exit(0);
}

const token = await mintInstallationToken();
process.stdout.write(`username=x-access-token\npassword=${token}\n`);
