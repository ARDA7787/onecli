// The provisioning pass: everything `pnpm run setup` writes into docker/.env.
//
// Deliberately ignores the shell environment (unlike `pnpm dev`): compose
// interpolates docker/.env on every future `docker compose` invocation, so an
// install must be complete ON DISK — a value living only in the wizard's
// shell would vanish with it.

import { resolveEnv } from "../lib/env-file.mjs";
import { ensureSecrets } from "../lib/secrets.mjs";
import {
  detectBindHost,
  detectDockerGid,
  legacyVolumeSecret,
} from "./detect.mjs";
import { SetupError } from "./errors.mjs";
import { log } from "./ui.mjs";

export const provisionEnv = async (envFile, opts) => {
  // The shell is deliberately ignored for WRITES (the file must be complete),
  // but compose itself prefers the shell over the env file at runtime — an
  // exported secret would silently shadow what we write here. Say so.
  for (const key of [
    "SECRET_ENCRYPTION_KEY",
    "BETTER_AUTH_SECRET",
    "GATEWAY_INTERNAL_SECRET",
  ])
    if (process.env[key] !== undefined)
      log.warn(
        `${key} is exported in your shell, so docker compose will prefer it over docker/.env. Unset it before running the stack, or the file's value never applies.`,
      );
  // Legacy carry-over BEFORE generation, same order as install.sh: a pre-2.0
  // install's key must win over a fresh one or its secrets go dark.
  if (!envFile.get("SECRET_ENCRYPTION_KEY")) {
    const legacy = legacyVolumeSecret();
    if (legacy) {
      envFile.upsert("SECRET_ENCRYPTION_KEY", legacy, {
        comment:
          "Carried over from the pre-2.0 install's app-data volume so existing secrets stay decryptable.",
      });
      log.step("Adopted SECRET_ENCRYPTION_KEY from the pre-2.0 volume");
    }
  }

  const { generated, replaced } = ensureSecrets(
    envFile,
    resolveEnv(envFile, {}),
    {},
  );
  if (generated.length) log.step(`Generated ${generated.join(", ")}`);
  for (const key of replaced)
    log.warn(
      `Replaced ${key}: the app rejects the existing value at runtime, so it never encrypted anything.`,
    );

  const existingBind = envFile.get("ONECLI_BIND_HOST");
  if (!existingBind) {
    const bind = opts.bind || detectBindHost();
    if (!bind)
      throw new SetupError(
        "Could not safely determine a bind address for OneCLI.",
        ["Re-run with an explicit address: pnpm run setup --bind=<your-ip>"],
      );
    envFile.upsert("ONECLI_BIND_HOST", bind, {
      comment:
        "Where published ports bind. Never 0.0.0.0 (that would expose the stack to the network).",
    });
  } else if (opts.bind && opts.bind !== existingBind)
    log.warn(
      `--bind=${opts.bind} ignored: docker/.env already sets ONECLI_BIND_HOST=${existingBind}; edit the file to change it.`,
    );

  // Hosted agents are the point — the runner is always on, no question asked
  // (`--no-runner` is the scripted opt-out), with the price named out loud:
  // the runner mounts the Docker socket. An existing COMPOSE_PROFILES line is
  // the operator's choice and is never rewritten; present-empty means
  // deliberately off.
  let profiles = envFile.get("COMPOSE_PROFILES");
  if (profiles === undefined) {
    const list = [];
    if (!opts.noRunner) list.push("runner");
    if (opts.channelAdapter) list.push("channel-adapter");
    profiles = list.join(",");
    envFile.upsert("COMPOSE_PROFILES", profiles, {
      comment:
        "Optional services: runner = hosted agents, channel-adapter = Slack. Empty disables both.",
    });
    log.step(
      opts.noRunner
        ? "Hosted agents off. Set COMPOSE_PROFILES=runner here later to enable them"
        : "Hosted agents enabled (runner profile; the runner mounts the Docker socket to start sandboxes)",
    );
  } else if (opts.noRunner || opts.channelAdapter)
    log.warn(
      "--no-runner/--channel-adapter ignored: docker/.env already sets COMPOSE_PROFILES; edit that line to change the services.",
    );

  // Written unconditionally (matching install.sh): the documented later-enable
  // path is editing COMPOSE_PROFILES in docker/.env, and the runner must not
  // then start with group_add "0" for want of a GID nobody detected.
  if (!envFile.has("DOCKER_GID"))
    envFile.upsert("DOCKER_GID", detectDockerGid(), {
      comment:
        "Group of /var/run/docker.sock as CONTAINERS see it (Docker Desktop's host view is wrong).",
    });

  return { profiles };
};
