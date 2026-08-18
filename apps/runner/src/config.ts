/**
 * Runner configuration. Every address is configuration with a LOCAL default
 * (plans/hosted-agents-v2.md §3.14 rule 3) — the identical binary points at a
 * remote control plane by changing one env var, which is what keeps "deploy
 * elsewhere later" a config change rather than a re-architecture.
 */

export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  pids: number;
}

export interface RunnerConfig {
  /** The runner's credential AND its registration anchor (§5.1). */
  token: string;
  controlPlaneUrl: string;
  name: string;
  /** Backend id — CONFIG, never detection. The composition root maps it. */
  backend: string;
  agentImage: string;
  sandboxNetwork: string;
  /** `internal` networks have no route out; the gateway is dual-homed onto
   * them. False only for local dev, where the gateway runs on the host. */
  networkInternal: boolean;
  wsPort: number;
  /** How a sandbox addresses this runner — a container-network name. */
  advertisedHost: string;
  maxSandboxes: number;
  limits: SandboxLimits;
  reconcileSeconds: number;
  dockerSocket: string;
  /**
   * Extra host→target entries for sandbox containers (`host:target`,
   * comma-separated; `host-gateway` targets the docker host). What lets a
   * Linux sandbox resolve `host.docker.internal` when the gateway runs on the
   * host — Docker Desktop provides the name natively, plain Linux does not.
   */
  sandboxExtraHosts: string[];
  /**
   * The stale-label orphan sweep (step 13): reap containers/volumes whose
   * sandbox no longer exists anywhere in the control plane. False = detect
   * and log, delete nothing — the operator kill-switch.
   */
  orphanReap: boolean;
  /** Minimum age before a stale-label object may be reaped. */
  orphanGraceSeconds: number;
}

const int = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  // Integer, not merely finite: a fractional port or pid limit is a
  // configuration mistake that should fall back, not reach the daemon.
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const bool = (raw: string | undefined, fallback: boolean): boolean =>
  raw === undefined || raw === "" ? fallback : raw !== "false" && raw !== "0";

export class ConfigError extends Error {}

export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
): RunnerConfig => {
  const token = env.RUNNER_TOKEN ?? "";
  if (!token) {
    throw new ConfigError(
      "RUNNER_TOKEN is required — the runner cannot register or authenticate without it.",
    );
  }
  // Checked here so a mistyped token fails at boot with a clear message,
  // rather than as an endless stream of hint-free 401s.
  if (!token.startsWith("rnr_")) {
    throw new ConfigError(
      'RUNNER_TOKEN must start with "rnr_" — the control plane rejects any other shape.',
    );
  }

  return {
    token,
    controlPlaneUrl: env.RUNNER_CONTROL_PLANE_URL ?? "http://localhost:10256",
    name: env.RUNNER_NAME ?? "runner",
    backend: env.RUNNER_BACKEND ?? "docker",
    agentImage: env.RUNNER_AGENT_IMAGE ?? "onecli-agent:dev",
    sandboxNetwork: env.RUNNER_SANDBOX_NETWORK ?? "onecli-sandboxes",
    networkInternal: bool(env.RUNNER_NETWORK_INTERNAL, true),
    wsPort: int(env.RUNNER_WS_PORT, 8484),
    advertisedHost: env.RUNNER_ADVERTISED_HOST ?? "runner",
    maxSandboxes: int(env.RUNNER_MAX_SANDBOXES, 4),
    limits: {
      memoryMb: int(env.RUNNER_SANDBOX_MEMORY_MB, 2048),
      cpus:
        Number(env.RUNNER_SANDBOX_CPUS) > 0
          ? Number(env.RUNNER_SANDBOX_CPUS)
          : 1,
      pids: int(env.RUNNER_SANDBOX_PIDS, 512),
    },
    reconcileSeconds: int(env.RUNNER_RECONCILE_SECONDS, 60),
    dockerSocket: env.RUNNER_DOCKER_SOCKET ?? "/var/run/docker.sock",
    sandboxExtraHosts: (env.RUNNER_SANDBOX_EXTRA_HOSTS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    orphanReap: bool(env.RUNNER_ORPHAN_REAP, true),
    orphanGraceSeconds: int(env.RUNNER_ORPHAN_GRACE_SECONDS, 3600),
  };
};
