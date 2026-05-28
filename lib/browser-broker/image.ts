// Broker image has @playwright/mcp preinstalled, so the default startup path
// works in offline/restricted CI. Custom non-MCP images still use the legacy
// npx fallback to preserve existing broker image overrides.
export const BROKER_IMAGE = 'mcr.microsoft.com/playwright/mcp:v0.0.30';

export const BROKER_MCP_PACKAGE = '@playwright/mcp@0.0.30';

export const BROKER_INTERNAL_PORT = 9333;
