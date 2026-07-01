import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import type { TestDbHandle } from '@/__tests__/helpers/test-db';
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

  describe('PATCH /agents/by-name', () => {
      async function seedAgent(db: TestDbHandle['db'], overrides: Partial<typeof schema.agents.$inferInsert> = {}) {
        const now = Date.now() / 1000;
        await db.insert(schema.agents).values({
          id: 'agent-bn',
          name: 'Self',
          project: 'myproj',
          skillIds: '[]',
          model: 'sonnet',
          prompt: 'original prompt',
          schedule: null,
  
          createdAt: now,
          updatedAt: now,
          ...overrides,
        });
      }
  
      it('returns 400 when project or name missing', async () => {
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj' }),
        }));
        expect(res.status).toBe(400);
      });
  
      it('rejects unsafe lookup names by project+name', async () => {
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'bad/name', prompt: 'x' }),
        }));
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({
          detail: expect.stringContaining('slashes'),
        });
      });
  
      it('returns 404 when no agent matches project+name', async () => {
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'Nobody' }),
        }));
        expect(res.status).toBe(404);
      });
  
      it('rejects schedule updates for system agents by project+name', async () => {
        await seedAgent(testDb.db, {
          id: 'system:myproj:documentation-reindex-vectors',
          name: 'documentation-reindex-vectors',
          kind: 'system',
          schedule: '1h',
        });
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({
            project: 'myproj',
            name: 'documentation-reindex-vectors',
            schedule: '8h',
          }),
        }));
  
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({
          detail: 'System agent schedule is managed by settings',
        });
      });
  
      it('updates prompt by project+name', async () => {
        await seedAgent(testDb.db);
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'Self', prompt: 'improved prompt' }),
        }));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.agent.prompt).toBe('improved prompt');
        const revisions = await testDb.db.select().from(schema.agentRevisions);
        expect(revisions).toHaveLength(1);
        expect(JSON.parse(revisions[0].snapshot).prompt).toBe('original prompt');
      });
  
      it('looks up DB agents by project+name case-insensitively', async () => {
        await seedAgent(testDb.db);
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'self', prompt: 'improved prompt' }),
        }));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.agent.prompt).toBe('improved prompt');
        expect(data.agent.name).toBe('Self');
      });
  
      it('renames DB agents with currentName + name', async () => {
        await seedAgent(testDb.db);
        resolveProjectPathMock.mockReturnValue('/path/to/myproj');
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', currentName: 'Self', name: 'Renamed', prompt: 'improved prompt' }),
        }));
  
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.agent.name).toBe('Renamed');
      });
  
      it('rejects case-only rename conflicts by project+name', async () => {
        await seedAgent(testDb.db);
        await seedAgent(testDb.db, { id: 'agent-other', name: 'Taken' });
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', currentName: 'Self', name: 'taken' }),
        }));
  
        expect(res.status).toBe(409);
        await expect(res.json()).resolves.toMatchObject({
          detail: expect.stringContaining('already exists'),
        });
      });
  
      it('updates prerequisiteCommand by project+name for DB agents', async () => {
        await seedAgent(testDb.db);
        resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({
            project: 'myproj',
            name: 'Self',
            prerequisiteCommand: '  echo ready  ',
          }),
        }));
  
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.agent.prerequisiteCommand).toBe('echo ready');
  
        const row = (await testDb.db.select().from(schema.agents)).find((agent) => agent.id === 'agent-bn');
        expect(row?.prerequisiteCommand).toBe('echo ready');
      });
  
      it('clears prerequisiteCommand by project+name for DB agents', async () => {
        await seedAgent(testDb.db, { prerequisiteCommand: 'echo ready' });
        resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({
            project: 'myproj',
            name: 'Self',
            prerequisiteCommand: '',
          }),
        }));
  
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.agent.prerequisiteCommand).toBeNull();
  
        const row = (await testDb.db.select().from(schema.agents)).find((agent) => agent.id === 'agent-bn');
        expect(row?.prerequisiteCommand).toBe('');
      });
  
      it('keeps an explicitly cleared issue-cruncher prerequisite blank by project+name for DB agents', async () => {
        await seedAgent(testDb.db, {
          skillIds: '["agent-issue-cruncher"]',
          prerequisiteCommand: 'echo ready',
        });
        resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({
            project: 'myproj',
            name: 'Self',
            prerequisiteCommand: '',
          }),
        }));
  
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.agent.prerequisiteCommand).toBeNull();
  
        const row = (await testDb.db.select().from(schema.agents)).find((agent) => agent.id === 'agent-bn');
        expect(row?.prerequisiteCommand).toBe('');
      });
  
      it('updates model by project+name', async () => {
        await seedAgent(testDb.db);
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'Self', model: 'opus' }),
        }));
        const data = await res.json();
        expect(data.agent.model).toBe('smart');
      });
  
      it('rejects invalid model values by project+name', async () => {
        await seedAgent(testDb.db);
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'Self', model: 'smart --resume injected' }),
        }));
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({
          detail: expect.stringContaining('Invalid model'),
        });
      });
  
      it('rejects invalid schedule values by project+name', async () => {
        await seedAgent(testDb.db);
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'Self', schedule: '1w' }),
        }));
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({
          detail: expect.stringContaining('Invalid schedule'),
        });
        expect(installAgentScheduleMock).not.toHaveBeenCalled();
        expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
      });
  
      it('normalizes schedule values by project+name before saving and scheduling', async () => {
        await seedAgent(testDb.db, { prompt: 'do work', schedule: null, enabled: true });
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'Self', schedule: ' 2H ' }),
        }));
  
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.agent.schedule).toBe('2h');
        expect(installAgentScheduleMock).toHaveBeenCalledWith(
          'agent-bn',
          '2h',
          'do work',
          'myproj',
          'Self'
        );
      });
  
      it('does not affect an agent with the same name in a different project', async () => {
        const now = Date.now() / 1000;
        await seedAgent(testDb.db);
        await testDb.db.insert(schema.agents).values({ id: 'agent-other', name: 'Self', project: 'other', skillIds: '[]', model: 'haiku', prompt: 'other prompt', schedule: null, createdAt: now, updatedAt: now });
  
        await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'Self', prompt: 'changed' }),
        }));
  
        const other = (await testDb.db.select().from(schema.agents)).find(a => a.id === 'agent-other');
        expect(other?.prompt).toBe('other prompt');
      });
  
      it('calls installAgentSchedule when prompt+schedule are set and enabled', async () => {
        await seedAgent(testDb.db, { prompt: 'do work', schedule: '1h', enabled: true });
        await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'Self', prompt: 'updated work' }),
        }));
        expect(installAgentScheduleMock).toHaveBeenCalledOnce();
      });
  
      it('calls installAgentSchedule for skills-only agent (no prompt) when schedule and enabled', async () => {
        await seedAgent(testDb.db, { prompt: '', skillIds: '["skill1"]', schedule: '1h', enabled: true });
        await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'Self', model: 'opus' }),
        }));
        expect(installAgentScheduleMock).toHaveBeenCalledOnce();
      });
  
      it('does not call installAgentSchedule when skills-only agent has no schedule', async () => {
        await seedAgent(testDb.db, { prompt: '', skillIds: '["skill1"]', schedule: null, enabled: true });
        await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'Self', model: 'opus' }),
        }));
        expect(installAgentScheduleMock).not.toHaveBeenCalled();
      });
  
      it('calls uninstallAgentSchedule (not install) when agent has empty skills, no prompt, but has schedule', async () => {
        await seedAgent(testDb.db, { prompt: '', skillIds: '[]', schedule: '1h', enabled: true });
        await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'Self', model: 'opus' }),
        }));
        expect(installAgentScheduleMock).not.toHaveBeenCalled();
        expect(uninstallAgentScheduleMock).toHaveBeenCalledOnce();
      });
  
      it('calls uninstallAgentSchedule (not install) when skills-only agent is disabled', async () => {
        await seedAgent(testDb.db, { prompt: '', skillIds: '["skill1"]', schedule: '1h', enabled: false });
        await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'Self', model: 'opus' }),
        }));
        expect(installAgentScheduleMock).not.toHaveBeenCalled();
        expect(uninstallAgentScheduleMock).toHaveBeenCalledOnce();
      });
  
    })
});
