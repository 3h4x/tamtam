import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getSettings } from './config';

export interface SandboxWrap {
  bin: string;
  args: string[];
  env: Record<string, string>;
}

function profilePath(): string {
  return join(
    process.env.TAMTAM_ROOT || process.cwd(),
    'scripts',
    'sandbox-profiles',
    'tamtam-loopback.sb',
  );
}

// When `tamtam_network_policy_strict` is on and we're on macOS, wrap the
// command in `sandbox-exec` with the TamTam loopback profile. The outer
// seatbelt profile blocks all egress except 127.0.0.1, which is where the
// browser broker listens. `bypassPermissions` skips the wrap entirely — that
// mode is the explicit escape hatch for power users.
export function wrapForSandbox(opts: {
  bin: string;
  args: string[];
  cwd: string;
  runDir?: string;
}): SandboxWrap {
  const settings = getSettings();
  if (!settings.tamtam_network_policy_strict) {
    return { bin: opts.bin, args: opts.args, env: {} };
  }
  if (settings.permission_mode === 'bypassPermissions') {
    return { bin: opts.bin, args: opts.args, env: {} };
  }
  if (process.platform !== 'darwin') {
    // Linux equivalent (bwrap/landlock-net) ships in a follow-up. See
    // docs/superpowers/specs/2026-05-21-sandboxed-playwright-broker-design.md.
    return { bin: opts.bin, args: opts.args, env: {} };
  }
  const profile = profilePath();
  if (!existsSync(/*turbopackIgnore: true*/ profile)) {
    console.warn(`[sandbox-wrap] profile not found at ${profile}; running un-wrapped`);
    return { bin: opts.bin, args: opts.args, env: {} };
  }
  const runDir = opts.runDir || '/tmp/tamtam-runs/default';
  return {
    bin: 'sandbox-exec',
    args: [
      '-D', `WORKSPACE=${opts.cwd}`,
      '-D', `HOME_DIR=${homedir()}`,
      '-D', `RUN_DIR=${runDir}`,
      '-f', profile,
      opts.bin,
      ...opts.args,
    ],
    env: { TAMTAM_SANDBOX_PROFILE: profile },
  };
}
