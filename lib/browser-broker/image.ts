// Broker image has @playwright/mcp preinstalled, so the default startup path
// works in offline/restricted CI. Custom non-MCP images still use the legacy
// npx fallback to preserve existing broker image overrides.
export const BROKER_IMAGE = 'mcr.microsoft.com/playwright/mcp:v0.0.30';

export const BROKER_MCP_PACKAGE = '@playwright/mcp@0.0.30';

export const BROKER_INTERNAL_PORT = 9333;

// Current Playwright MCP exposes streamable HTTP at /mcp; older releases used
// the SSE endpoint at /sse. Probe in this order so pinned images can advance
// without breaking older custom images.
export const BROKER_MCP_ENDPOINT_PATHS = ['/mcp', '/sse'] as const;
