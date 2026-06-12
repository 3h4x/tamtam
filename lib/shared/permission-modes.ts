// Client-safe permission-mode primitives. Client components (terminal
// toolbar/tab) need the mode list and normalizer, but `lib/shared/config.ts`
// is a server module (fs/process access) that breaks client bundles —
// keep these dependency-free so both sides can import them.

export const VALID_PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'] as const;
export type PermissionMode = (typeof VALID_PERMISSION_MODES)[number];

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

export function normalizePermissionMode(value: string | undefined): PermissionMode {
  return (VALID_PERMISSION_MODES as readonly string[]).includes(value ?? '')
    ? value as PermissionMode
    : DEFAULT_PERMISSION_MODE;
}
