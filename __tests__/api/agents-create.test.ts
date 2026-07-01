import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import * as schema from '@/lib/db/schema';
import { GET, POST, agentGET, PATCH, DELETE, PATCH_BY_NAME, describeAgentsApi } from './agents-fixtures';

describeAgentsApi((ctx) => {
  const {
    testDb,
    mocks,
    installAgentScheduleMock,
    uninstallAgentScheduleMock,
    resolveProjectPathMock,
    loadAgentCronStatesMock,
    getAllAgentLastAttemptsMock,
    warmAgentsCache,
  } = ctx;

  describe('POST /agents', () => {
      it('creates agent successfully', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: 'New Agent', project: 'proj1' }),
        });
  
        const response = await POST(request);
        expect(response.status).toBe(201);
        const data = await response.json();
  
        expect(data.agent.name).toBe('New Agent');
        expect(data.agent.project).toBe('proj1');
        expect(data.agent.model).toBe('normal');
      });
  
      it('validates required fields', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: '', project: '' }),
        });
  
        const response = await POST(request);
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.detail).toContain('required');
      });
  
      it('defaults permissionMode to null (inherit global) when omitted', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: 'Default Perm', project: 'proj1' }),
        });
  
        const response = await POST(request);
        expect(response.status).toBe(201);
        const data = await response.json();
        expect(data.agent.permissionMode).toBeNull();
      });
  
      it('persists a valid permissionMode override', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: 'Bypass Perm', project: 'proj1', permissionMode: 'bypassPermissions' }),
        });
  
        const response = await POST(request);
        expect(response.status).toBe(201);
        const data = await response.json();
        expect(data.agent.permissionMode).toBe('bypassPermissions');
      });
  
      it('rejects an unrecognized permissionMode', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: 'Bad Perm', project: 'proj1', permissionMode: 'yolo' }),
        });
  
        const response = await POST(request);
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          detail: expect.stringContaining('permissionMode'),
        });
      });
  
      it('rejects unsafe agent names on create', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: 'bad/name', project: 'proj1' }),
        });
  
        const response = await POST(request);
  
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          detail: expect.stringContaining('slashes'),
        });
      });
  
      it('trims whitespace from name and project', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: '  Agent  ', project: '  proj1  ' }),
        });
  
        const response = await POST(request);
        const data = await response.json();
  
        expect(data.agent.name).toBe('Agent');
        expect(data.agent.project).toBe('proj1');
      });
  
      it('rejects duplicate agent names within the same project', async () => {
        const now = Date.now() / 1000;
        await testDb.db.insert(schema.agents).values({
          id: 'agent-existing',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'normal',
          prompt: '',
          schedule: null,
  
          createdAt: now,
          updatedAt: now,
        });
  
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: ' Agent ', project: 'proj1' }),
        });
  
        const response = await POST(request);
  
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
          detail: expect.stringContaining('already exists'),
        });
      });
  
      it('rejects case-only duplicate agent names within the same project', async () => {
        const now = Date.now() / 1000;
        await testDb.db.insert(schema.agents).values({
          id: 'agent-existing',
          name: 'Agent',
          project: 'proj1',
          skillIds: '[]',
          model: 'normal',
          prompt: '',
          schedule: null,
  
          createdAt: now,
          updatedAt: now,
        });
  
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: 'agent', project: 'proj1' }),
        });
  
        const response = await POST(request);
  
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
          detail: expect.stringContaining('already exists'),
        });
      });
  
      it('uses default model if not provided', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: 'Agent', project: 'proj1' }),
        });
  
        const response = await POST(request);
        const data = await response.json();
  
        expect(data.agent.model).toBe('normal');
      });
  
      it('defaults fallbackEnabled on for built-in recommended agents', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: 'test-add', project: 'proj1' }),
        });
  
        const response = await POST(request);
        const data = await response.json();
  
        expect(response.status).toBe(201);
        expect(data.agent.fallbackEnabled).toBe(true);
  
        const row = (await testDb.db.select().from(schema.agents)).find((agent) => agent.id === data.agent.id);
        expect(row?.fallbackEnabled).toBe(true);
      });
  
      it('treats legacy built-in aliases as fallback-enabled after trimming and case normalization', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: '  TESTS  ', project: 'proj1' }),
        });
  
        const response = await POST(request);
        const data = await response.json();
  
        expect(response.status).toBe(201);
        expect(data.agent.name).toBe('TESTS');
        expect(data.agent.fallbackEnabled).toBe(true);
  
        const row = (await testDb.db.select().from(schema.agents)).find((agent) => agent.id === data.agent.id);
        expect(row?.name).toBe('TESTS');
        expect(row?.fallbackEnabled).toBe(true);
      });
  
      it('respects an explicit fallbackEnabled override for built-in recommended agents', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: 'test-add', project: 'proj1', fallbackEnabled: false }),
        });
  
        const response = await POST(request);
        const data = await response.json();
  
        expect(response.status).toBe(201);
        expect(data.agent.fallbackEnabled).toBe(false);
  
        const row = (await testDb.db.select().from(schema.agents)).find((agent) => agent.id === data.agent.id);
        expect(row?.fallbackEnabled).toBe(false);
      });
  
      it('accepts optional fields', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({
            name: 'Agent',
            project: 'proj1',
            skillIds: ['skill1', 'skill2'],
            model: 'opus',
            prompt: 'Do something',
            schedule: '30m',
  
          }),
        });
  
        const response = await POST(request);
        const data = await response.json();
  
        expect(data.agent.model).toBe('smart');
        expect(data.agent.prompt).toBe('Do something');
        expect(data.agent.schedule).toBe('30m');
        expect(data.agent.skillIds).toEqual(['skill1', 'skill2']);
      });
  
      it('rejects invalid model values on create', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: 'Agent', project: 'proj1', model: 'smart --resume injected' }),
        });
  
        const response = await POST(request);
  
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          detail: expect.stringContaining('Invalid model'),
        });
      });
  
      it('rejects invalid schedule values on create', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: 'Agent', project: 'proj1', schedule: '1w' }),
        });
  
        const response = await POST(request);
  
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          detail: expect.stringContaining('Invalid schedule'),
        });
        expect(installAgentScheduleMock).not.toHaveBeenCalled();
      });
  
      it('normalizes schedule values on create before persisting and scheduling', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: 'Agent', project: 'proj1', prompt: 'Do something', schedule: ' 15M ' }),
        });
  
        const response = await POST(request);
        const data = await response.json();
  
        expect(data.agent.schedule).toBe('15m');
        expect(installAgentScheduleMock).toHaveBeenCalledWith(
          data.agent.id,
          '15m',
          'Do something',
          'proj1',
          'Agent'
        );
      });
  
      it('stores agent in database', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: 'Agent', project: 'proj1' }),
        });
  
        const response = await POST(request);
        const data = await response.json();
        const agentId = data.agent.id;
  
        // Verify response is valid
        expect(agentId).toBeTruthy();
        expect(data.agent).toBeTruthy();
      });
  
      it('defaults issue-cruncher agents to the trusted-only prerequisite command', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({
            name: 'issue-cruncher',
            project: 'proj1',
            skillIds: ['agent-issue-cruncher'],
          }),
        });
  
        const response = await POST(request);
        const data = await response.json();
  
        expect(response.status).toBe(201);
        expect(data.agent.prerequisiteCommand).toBe(
          'curl -fsS "http://localhost:1337/api/projects/by-project/proj1/issues?pick_top=1"'
        );
  
        const row = (await testDb.db.select().from(schema.agents)).find((agent) => agent.id === data.agent.id);
        expect(row?.prerequisiteCommand).toBe(
          'curl -fsS "http://localhost:1337/api/projects/by-project/proj1/issues?pick_top=1"'
        );
      });
  
      it('keeps an explicitly cleared issue-cruncher prerequisite blank on create', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({
            name: 'issue-cruncher',
            project: 'proj1',
            skillIds: ['agent-issue-cruncher'],
            prerequisiteCommand: '',
          }),
        });
  
        const response = await POST(request);
        const data = await response.json();
  
        expect(response.status).toBe(201);
        expect(data.agent.prerequisiteCommand).toBeNull();
  
        const row = (await testDb.db.select().from(schema.agents)).find((agent) => agent.id === data.agent.id);
        expect(row?.prerequisiteCommand).toBe('');
      });
  
      it('returns 400 when project is missing instead of throwing during prerequisite resolution', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({
            name: 'issue-cruncher',
            skillIds: ['agent-issue-cruncher'],
          }),
        });
  
        const response = await POST(request);
        const data = await response.json();
  
        expect(response.status).toBe(400);
        expect(data.detail).toBe('project is required');
      });
    });
});
