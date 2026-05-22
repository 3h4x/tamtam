#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(process.env.TAMTAM_MCP_HTTP_CONFIG ?? resolve(repoRoot, '.tamtam/mcp-http-tools.yaml'));
const httpToolsDir = resolve(process.env.MCP_HTTP_TOOLS_DIR ?? resolve(repoRoot, '../mcp-http-tools'));
const libPath = resolve(httpToolsDir, 'lib.js');

function usage() {
  process.stderr.write([
    'Usage: pnpm mcp:http <tool_name> [json_args]',
    '',
    'Examples:',
    '  pnpm mcp:http tamtam_health',
    '  pnpm mcp:http tamtam_project_recommendations \'{"project":"<project>"}\'',
    '',
    'Environment:',
    '  MCP_HTTP_TOOLS_DIR=/path/to/mcp-http-tools',
    '  TAMTAM_MCP_HTTP_CONFIG=/path/to/config.yaml',
    '',
  ].join('\n'));
}

const [toolName, rawArgs] = process.argv.slice(2);
if (!toolName) {
  usage();
  process.exit(2);
}

if (!existsSync(libPath)) {
  process.stderr.write(`mcp-http-tools lib not found at ${libPath}\n`);
  process.stderr.write('Set MCP_HTTP_TOOLS_DIR to the mcp-http-tools checkout.\n');
  process.exit(2);
}

const { loadConfig, validateConfig, callTool } = await import(pathToFileURL(libPath).href);
const config = loadConfig([configPath]);
const errors = validateConfig(config);
if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`[mcp-http-tools] config error: ${error}\n`);
  process.exit(1);
}

const tool = (config.tools ?? []).find((candidate) => candidate.name === toolName);
if (!tool) {
  const names = (config.tools ?? []).map((candidate) => candidate.name).join(', ');
  process.stderr.write(`Unknown tool: ${toolName}\n`);
  process.stderr.write(`Available tools: ${names || '(none)'}\n`);
  process.exit(2);
}

let args = {};
if (rawArgs) {
  try {
    args = JSON.parse(rawArgs);
  } catch (error) {
    process.stderr.write(`Invalid json_args: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

const result = await callTool(tool, args);
process.stdout.write(result.text);
if (!result.text.endsWith('\n')) process.stdout.write('\n');
if (result.isError) process.exit(1);
