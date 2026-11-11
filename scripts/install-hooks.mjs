// Points git at the committed .githooks/ directory (pre-push gate).
// Runs from `prepare`. Does nothing unless this package is itself a git
// checkout (.git in the package root): an install from the registry, or from
// a git URL inside someone else's repo, must not touch that repo's config.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync(".git")) process.exit(0);

execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
  stdio: "inherit",
});
