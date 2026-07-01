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

  describe('PATCH /agents/{agentId}', () => {
      it('returns 404 for nonexistent agent', async () => {
        const request = new NextRequest('http://localhost/api/agents/nonexistent', {
          method: 'PATCH',
          body: JSON.stringify({ name: 'Updated' }),
        });

        const response = await PATCH(request, {
          params: Promise.resolve({ agentId: 'nonexistent' }),
        });

        expect(response.status).toBe(404);
        const data = await response.json();
        expect(data.detail).toBe('not found');
      });

      it('rejects schedule updates for system agents', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'system:proj1:documentation-reindex-vectors',
            name: 'documentation-reindex-vectors',
            project: 'proj1',
            skillIds: '[]',
            model: 'normal',
            prompt: '',
            schedule: '1h',
            kind: 'system',
            createdAt: now,
            updatedAt: now,
          });

        const response = await PATCH(new NextRequest('http://localhost/api/agents/system%3Aproj1%3Adocumentation-reindex-vectors', {
          method: 'PATCH',
          body: JSON.stringify({ schedule: '8h' }),
        }), {
          params: Promise.resolve({ agentId: 'system:proj1:documentation-reindex-vectors' }),
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          detail: 'System agent schedule is managed by settings',
        });
      });

      it('updates agent name', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-123',
            name: 'Old Name',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: '',
            schedule: null,

            createdAt: now,
            updatedAt: now,
          });

        const request = new NextRequest('http://localhost/api/agents/agent-123', {
          method: 'PATCH',
          body: JSON.stringify({ name: 'New Name' }),
        });

        const response = await PATCH(request, {
          params: Promise.resolve({ agentId: 'agent-123' }),
        });

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.agent.name).toBe('New Name');
      });

      it('updates and clears a permissionMode override', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-perm',
            name: 'Perm Agent',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: '',
            schedule: null,
            createdAt: now,
            updatedAt: now,
          });

        const set = await PATCH(new NextRequest('http://localhost/api/agents/agent-perm', {
          method: 'PATCH',
          body: JSON.stringify({ permissionMode: 'acceptEdits' }),
        }), { params: Promise.resolve({ agentId: 'agent-perm' }) });
        expect(set.status).toBe(200);
        expect((await set.json()).agent.permissionMode).toBe('acceptEdits');

        // Empty string clears the override back to inherit-global (null).
        const cleared = await PATCH(new NextRequest('http://localhost/api/agents/agent-perm', {
          method: 'PATCH',
          body: JSON.stringify({ permissionMode: '' }),
        }), { params: Promise.resolve({ agentId: 'agent-perm' }) });
        expect(cleared.status).toBe(200);
        expect((await cleared.json()).agent.permissionMode).toBeNull();
      });

      it('rejects an unrecognized permissionMode on update', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-perm-bad',
            name: 'Perm Bad',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: '',
            schedule: null,
            createdAt: now,
            updatedAt: now,
          });

        const response = await PATCH(new NextRequest('http://localhost/api/agents/agent-perm-bad', {
          method: 'PATCH',
          body: JSON.stringify({ permissionMode: 'nope' }),
        }), { params: Promise.resolve({ agentId: 'agent-perm-bad' }) });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          detail: expect.stringContaining('permissionMode'),
        });
      });

      it('rejects unsafe agent names on update', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-123',
            name: 'Old Name',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: '',
            schedule: null,

            createdAt: now,
            updatedAt: now,
          });

        const response = await PATCH(new NextRequest('http://localhost/api/agents/agent-123', {
          method: 'PATCH',
          body: JSON.stringify({ name: 'bad/name' }),
        }), {
          params: Promise.resolve({ agentId: 'agent-123' }),
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          detail: expect.stringContaining('slashes'),
        });
      });

      it('rejects duplicate agent names on update', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-123',
            name: 'Old Name',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: '',
            schedule: null,

            createdAt: now,
            updatedAt: now,
          });
        await db.insert(schema.agents)
          .values({
            id: 'agent-456',
            name: 'Taken',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: '',
            schedule: null,

            createdAt: now,
            updatedAt: now,
          });

        const response = await PATCH(new NextRequest('http://localhost/api/agents/agent-123', {
          method: 'PATCH',
          body: JSON.stringify({ name: ' Taken ' }),
        }), {
          params: Promise.resolve({ agentId: 'agent-123' }),
        });

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
          detail: expect.stringContaining('already exists'),
        });
      });

      it('rejects case-only duplicate agent names on update', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-123',
            name: 'Old Name',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: '',
            schedule: null,

            createdAt: now,
            updatedAt: now,
          });
        await db.insert(schema.agents)
          .values({
            id: 'agent-456',
            name: 'Taken',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: '',
            schedule: null,

            createdAt: now,
            updatedAt: now,
          });

        const response = await PATCH(new NextRequest('http://localhost/api/agents/agent-123', {
          method: 'PATCH',
          body: JSON.stringify({ name: 'taken' }),
        }), {
          params: Promise.resolve({ agentId: 'agent-123' }),
        });

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
          detail: expect.stringContaining('already exists'),
        });
      });

      it('updates agent model and prompt', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-123',
            name: 'Agent',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: 'old prompt',
            schedule: null,

            createdAt: now,
            updatedAt: now,
          });

        const request = new NextRequest('http://localhost/api/agents/agent-123', {
          method: 'PATCH',
          body: JSON.stringify({ model: 'opus', prompt: 'new prompt' }),
        });

        const response = await PATCH(request, {
          params: Promise.resolve({ agentId: 'agent-123' }),
        });

        const data = await response.json();
        expect(data.agent.model).toBe('smart');
        expect(data.agent.prompt).toBe('new prompt');
      });

      it('keeps an explicitly cleared issue-cruncher prerequisite blank after PATCH by id', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-issue',
            name: 'Issue Cruncher',
            project: 'proj1',
            skillIds: '["agent-issue-cruncher"]',
            model: 'normal',
            prompt: '',
            schedule: null,

            prerequisiteCommand: 'echo old',
            createdAt: now,
            updatedAt: now,
          });
        resolveProjectPathMock.mockReturnValueOnce('/path/to/proj1');

        const response = await PATCH(new NextRequest('http://localhost/api/agents/agent-issue', {
          method: 'PATCH',
          body: JSON.stringify({ prerequisiteCommand: '' }),
        }), {
          params: Promise.resolve({ agentId: 'agent-issue' }),
        });

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.agent.prerequisiteCommand).toBeNull();

        const row = (await testDb.db.select().from(schema.agents)).find((agent) => agent.id === 'agent-issue');
        expect(row?.prerequisiteCommand).toBe('');
      });

      it('rejects invalid model values on update', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-123',
            name: 'Agent',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: 'old prompt',
            schedule: null,

            createdAt: now,
            updatedAt: now,
          });

        const request = new NextRequest('http://localhost/api/agents/agent-123', {
          method: 'PATCH',
          body: JSON.stringify({ model: 'smart --resume injected' }),
        });

        const response = await PATCH(request, {
          params: Promise.resolve({ agentId: 'agent-123' }),
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          detail: expect.stringContaining('Invalid model'),
        });
      });

      it('rejects invalid schedule values on update', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-123',
            name: 'Agent',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: 'old prompt',
            schedule: '1h',

            createdAt: now,
            updatedAt: now,
          });

        const request = new NextRequest('http://localhost/api/agents/agent-123', {
          method: 'PATCH',
          body: JSON.stringify({ schedule: '1w' }),
        });

        const response = await PATCH(request, {
          params: Promise.resolve({ agentId: 'agent-123' }),
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          detail: expect.stringContaining('Invalid schedule'),
        });
        expect(installAgentScheduleMock).not.toHaveBeenCalled();
        expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
      });

      it('updates skillIds as JSON array', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-123',
            name: 'Agent',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: '',
            schedule: null,

            createdAt: now,
            updatedAt: now,
          });

        const request = new NextRequest('http://localhost/api/agents/agent-123', {
          method: 'PATCH',
          body: JSON.stringify({ skillIds: ['skill1', 'skill2'] }),
        });

        const response = await PATCH(request, {
          params: Promise.resolve({ agentId: 'agent-123' }),
        });

        const data = await response.json();
        expect(data.agent.skillIds).toEqual(['skill1', 'skill2']);
      });

      it('clears schedule when empty string provided', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-123',
            name: 'Agent',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: 'do things',
            schedule: '1h',

            createdAt: now,
            updatedAt: now,
          });

        const request = new NextRequest('http://localhost/api/agents/agent-123', {
          method: 'PATCH',
          body: JSON.stringify({ schedule: '' }),
        });

        const response = await PATCH(request, {
          params: Promise.resolve({ agentId: 'agent-123' }),
        });

        const data = await response.json();
        expect(data.agent.schedule).toBeNull();
      });

      it('updates updatedAt timestamp', async () => {
        const db = testDb.db;
        const oldTime = Date.now() / 1000 - 100;
        await db.insert(schema.agents)
          .values({
            id: 'agent-123',
            name: 'Agent',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: '',
            schedule: null,

            createdAt: oldTime,
            updatedAt: oldTime,
          });

        const before = Date.now() / 1000;

        const request = new NextRequest('http://localhost/api/agents/agent-123', {
          method: 'PATCH',
          body: JSON.stringify({ name: 'Updated' }),
        });

        const response = await PATCH(request, {
          params: Promise.resolve({ agentId: 'agent-123' }),
        });

        const data = await response.json();
        expect(data.agent.updatedAt).toBeGreaterThanOrEqual(before);
      });
    });
});
