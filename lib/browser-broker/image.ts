// Broker image is the upstream Playwright image; `@playwright/mcp` is fetched
// at container start via npx. Pinning here so a Playwright release can't change
// behavior under us. Tag updates go through a docs/SETTINGS.md entry.
export const BROKER_IMAGE = 'mcr.microsoft.com/playwright:v1.59.1-noble';

export const BROKER_MCP_PACKAGE = '@playwright/mcp@0.0.30';

export const BROKER_INTERNAL_PORT = 9333;
