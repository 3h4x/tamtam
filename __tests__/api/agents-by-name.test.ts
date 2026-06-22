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
    scanFileAgentsMock,
    renameFileAgentMock,
    parseFileAgentIdMock,
    loadFileAgentMock,
    writeFileAgentMock,
    deleteFileAgentMock,
    setFileAgentOverrideMock,
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
        expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'Renamed', expect.anything());
      });
  
      it('renames file agents with currentName + name', async () => {
        resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
        scanFileAgentsMock.mockReturnValueOnce([{
          id: 'file:myproj:Self',
          name: 'Self',
          project: 'myproj',
          skillIds: [],
          docPaths: [],
          model: 'normal',
          prompt: 'original prompt',
          schedule: null,
  
          enabled: true,
          provider: null,
          prerequisiteCommand: null,
          createdAt: 0,
          updatedAt: 0,
          source: 'file' as const,
          filePath: '/path/to/myproj/.tamtam/agents/Self.md',
        }]);
        renameFileAgentMock.mockReturnValueOnce({
          id: 'file:myproj:Renamed',
          name: 'Renamed',
          project: 'myproj',
          skillIds: [],
          docPaths: [],
          model: 'normal',
          prompt: 'renamed prompt',
          schedule: null,
  
          enabled: true,
          provider: null,
          prerequisiteCommand: null,
          createdAt: 0,
          updatedAt: 0,
          source: 'file' as const,
          filePath: '/path/to/myproj/.tamtam/agents/Renamed.md',
        });
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', currentName: 'Self', name: 'Renamed', prompt: 'renamed prompt' }),
        }));
  
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.agent.name).toBe('Renamed');
        expect(renameFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'Self', 'Renamed', expect.anything());
      });
  
      it('renames file agents safely when only the case changes', async () => {
        resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
        scanFileAgentsMock.mockReturnValueOnce([{
          id: 'file:myproj:Self',
          name: 'Self',
          project: 'myproj',
          skillIds: [],
          docPaths: [],
          model: 'normal',
          prompt: 'original prompt',
          schedule: null,
  
          enabled: true,
          provider: null,
          prerequisiteCommand: null,
          createdAt: 0,
          updatedAt: 0,
          source: 'file' as const,
          filePath: '/path/to/myproj/.tamtam/agents/Self.md',
        }]);
        renameFileAgentMock.mockReturnValueOnce({
          id: 'file:myproj:self',
          name: 'self',
          project: 'myproj',
          skillIds: [],
          docPaths: [],
          model: 'normal',
          prompt: 'renamed prompt',
          schedule: null,
  
          enabled: true,
          provider: null,
          prerequisiteCommand: null,
          createdAt: 0,
          updatedAt: 0,
          source: 'file' as const,
          filePath: '/path/to/myproj/.tamtam/agents/self.md',
        });
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', currentName: 'Self', name: 'self', prompt: 'renamed prompt' }),
        }));
  
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.agent.name).toBe('self');
        expect(renameFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'Self', 'self', expect.anything());
        expect(writeFileAgentMock).not.toHaveBeenCalled();
        expect(deleteFileAgentMock).not.toHaveBeenCalled();
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
        expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'Self', expect.objectContaining({
          prerequisiteCommand: 'echo ready',
        }));
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
        expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'Self', expect.objectContaining({
          prerequisiteCommand: '',
        }));
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
        expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'Self', expect.objectContaining({
          prerequisiteCommand: '',
        }));
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
  
      it('falls back to file agent when no DB agent matches project+name', async () => {
        const fakeAgent = {
          id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
          skillIds: [] as string[], model: 'sonnet', prompt: 'updated', schedule: null,
   enabled: true, createdAt: 0, updatedAt: 0,
          source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
        };
        resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
        scanFileAgentsMock.mockReturnValueOnce([fakeAgent]);
        writeFileAgentMock.mockReturnValueOnce(fakeAgent);
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'my-agent', prompt: 'updated' }),
        }));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.agent.id).toBe('file:myproj:my-agent');
        expect(writeFileAgentMock).toHaveBeenCalledOnce();
      });
  
      it('persists an in-place enable for a file agent to the DB override (regression)', async () => {
        // The .md frontmatter does not carry `enabled` — it lives in the DB
        // override. Before the fix, by-name only wrote the override on rename, so
        // enabling a file agent in place (no rename) was silently dropped.
        const enabledAgent = {
          id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
          skillIds: [] as string[], model: 'sonnet', prompt: 'p', schedule: '30m',
          enabled: true, createdAt: 0, updatedAt: 0,
          source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
        };
        resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
        scanFileAgentsMock.mockReturnValueOnce([{ ...enabledAgent, enabled: false }]);
        writeFileAgentMock.mockReturnValueOnce(enabledAgent);
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'my-agent', enabled: true }),
        }));
  
        expect(res.status).toBe(200);
        expect(mocks.setFileAgentOverride).toHaveBeenCalledWith(
          'myproj',
          'my-agent',
          expect.objectContaining({ enabled: true }),
        );
      });
  
      it('persists boostable updates for a file agent to the DB override and file write payload', async () => {
        const existingAgent = {
          id: 'file:myproj:publisher', name: 'publisher', project: 'myproj',
          skillIds: [] as string[], model: 'sonnet', prompt: 'publish carefully', schedule: '30m',
          enabled: true, boostable: true, createdAt: 0, updatedAt: 0,
          source: 'file' as const, filePath: '/path/to/.tamtam/agents/publisher.md',
        };
        const updatedAgent = { ...existingAgent, boostable: false };
        resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
        scanFileAgentsMock.mockReturnValueOnce([existingAgent]);
        writeFileAgentMock.mockReturnValueOnce(updatedAgent);
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'publisher', boostable: false }),
        }));
  
        expect(res.status).toBe(200);
        expect(mocks.setFileAgentOverride).toHaveBeenCalledWith(
          'myproj',
          'publisher',
          expect.objectContaining({ boostable: false }),
        );
        expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'publisher', expect.objectContaining({
          boostable: false,
        }));
      });
  
      it('updates prerequisiteCommand in by-name file-agent fallback', async () => {
        const existingAgent = {
          id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
          skillIds: [] as string[], model: 'sonnet', prompt: 'updated', schedule: null,
   enabled: true, createdAt: 0, updatedAt: 0,
          prerequisiteCommand: 'echo old',
          source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
        };
        const updatedAgent = { ...existingAgent, prerequisiteCommand: 'echo fresh' };
        resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
        scanFileAgentsMock.mockReturnValueOnce([existingAgent]);
        writeFileAgentMock.mockReturnValueOnce(updatedAgent);
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({
            project: 'myproj',
            name: 'my-agent',
            prerequisiteCommand: '  echo fresh  ',
          }),
        }));
  
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.agent.prerequisiteCommand).toBe('echo fresh');
        expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'my-agent', {
          prompt: 'updated',
          model: 'sonnet',
          schedule: null,
          skillIds: [],
  
          enabled: true,
          boostable: true,
          provider: undefined,
          prerequisiteCommand: 'echo fresh',
        });
      });
  
      it('clears prerequisiteCommand in by-name file-agent fallback', async () => {
        const existingAgent = {
          id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
          skillIds: [] as string[], model: 'sonnet', prompt: 'updated', schedule: null,
   enabled: true, createdAt: 0, updatedAt: 0,
          prerequisiteCommand: 'echo old',
          source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
        };
        const updatedAgent = { ...existingAgent, prerequisiteCommand: null };
        resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
        scanFileAgentsMock.mockReturnValueOnce([existingAgent]);
        writeFileAgentMock.mockReturnValueOnce(updatedAgent);
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({
            project: 'myproj',
            name: 'my-agent',
            prerequisiteCommand: '',
          }),
        }));
  
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.agent.prerequisiteCommand).toBeNull();
        expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'my-agent', {
          prompt: 'updated',
          model: 'sonnet',
          schedule: null,
          skillIds: [],
  
          enabled: true,
          boostable: true,
          provider: undefined,
          prerequisiteCommand: '',
        });
      });
  
      it('keeps an explicitly cleared issue-cruncher prerequisite blank in by-name file-agent fallback', async () => {
        const existingAgent = {
          id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
          skillIds: ['agent-issue-cruncher'] as string[], model: 'sonnet', prompt: 'updated', schedule: null,
   enabled: true, createdAt: 0, updatedAt: 0,
          prerequisiteCommand: 'echo old',
          source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
        };
        const updatedAgent = { ...existingAgent, prerequisiteCommand: '' };
        resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
        scanFileAgentsMock.mockReturnValueOnce([existingAgent]);
        writeFileAgentMock.mockReturnValueOnce(updatedAgent);
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({
            project: 'myproj',
            name: 'my-agent',
            prerequisiteCommand: '',
          }),
        }));
  
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.agent.prerequisiteCommand).toBeNull();
        expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'my-agent', {
          prompt: 'updated',
          model: 'sonnet',
          schedule: null,
          skillIds: ['agent-issue-cruncher'],
  
          enabled: true,
          boostable: true,
          provider: undefined,
          prerequisiteCommand: '',
        });
      });
  
      it('preserves an existing file-agent schedule in by-name fallback when schedule is omitted', async () => {
        const existingAgent = {
          id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
          skillIds: [] as string[], model: 'sonnet', prompt: 'do work', schedule: '2h',
   enabled: true, createdAt: 0, updatedAt: 0,
          source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
        };
        const updatedAgent = { ...existingAgent, prompt: 'updated' };
        resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
        scanFileAgentsMock.mockReturnValueOnce([existingAgent]);
        writeFileAgentMock.mockReturnValueOnce(updatedAgent);
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'my-agent', prompt: 'updated' }),
        }));
  
        expect(res.status).toBe(200);
        expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/myproj', 'myproj', 'my-agent', {
          prompt: 'updated',
          model: 'sonnet',
          schedule: '2h',
          skillIds: [],
  
          enabled: true,
          boostable: true,
          provider: undefined,
          prerequisiteCommand: undefined,
        });
        expect(installAgentScheduleMock).toHaveBeenCalledWith(
          'file:myproj:my-agent', '2h', 'updated', 'myproj', 'my-agent'
        );
        expect(uninstallAgentScheduleMock).not.toHaveBeenCalled();
      });
  
      it('preserves provider when syncing a DB agent back to the file', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-123',
            name: 'Agent',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: 'updated prompt',
            schedule: null,
  
            enabled: true,
            provider: 'codex',
            createdAt: now,
            updatedAt: now,
          });
        resolveProjectPathMock.mockReturnValueOnce('/path/to/proj1');
  
        const request = new NextRequest('http://localhost/api/agents/agent-123', {
          method: 'PATCH',
          body: JSON.stringify({ prompt: 'updated prompt' }),
        });
  
        const response = await PATCH(request, {
          params: Promise.resolve({ agentId: 'agent-123' }),
        });
  
        expect(response.status).toBe(200);
        expect(writeFileAgentMock).toHaveBeenCalledWith('/path/to/proj1', 'proj1', 'Agent', {
          prompt: 'updated prompt',
          model: 'sonnet',
          schedule: null,
          skillIds: [],
          enabled: true,
          boostable: true,
          provider: 'codex',
          prerequisiteCommand: null,
        });
      });
  
      it('rejects invalid model values for by-name file agent fallback', async () => {
        const fakeAgent = {
          id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
          skillIds: [] as string[], model: 'sonnet', prompt: 'updated', schedule: null,
   enabled: true, createdAt: 0, updatedAt: 0,
          source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
        };
        resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
        scanFileAgentsMock.mockReturnValueOnce([fakeAgent]);
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'my-agent', model: 'smart --resume injected' }),
        }));
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({
          detail: expect.stringContaining('Invalid model'),
        });
        expect(writeFileAgentMock).not.toHaveBeenCalled();
      });
  
      it('returns 404 when no DB agent and no file agent found', async () => {
        resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
        // scanFileAgents returns [] by default — no file agent either
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'nonexistent' }),
        }));
        expect(res.status).toBe(404);
      });
  
      it('calls installAgentSchedule for file agent fallback with schedule, prompt, and enabled', async () => {
        const fakeAgent = {
          id: 'file:myproj:my-agent', name: 'my-agent', project: 'myproj',
          skillIds: [] as string[], model: 'sonnet', prompt: 'do work', schedule: '2h',
   enabled: true, createdAt: 0, updatedAt: 0,
          source: 'file' as const, filePath: '/path/to/.tamtam/agents/my-agent.md',
        };
        resolveProjectPathMock.mockReturnValueOnce('/path/to/myproj');
        scanFileAgentsMock.mockReturnValueOnce([fakeAgent]);
        writeFileAgentMock.mockReturnValueOnce(fakeAgent);
  
        const res = await PATCH_BY_NAME(new NextRequest('http://localhost/api/agents/by-name', {
          method: 'PATCH',
          body: JSON.stringify({ project: 'myproj', name: 'my-agent', schedule: '2h' }),
        }));
        expect(res.status).toBe(200);
        expect(installAgentScheduleMock).toHaveBeenCalledOnce();
        expect(installAgentScheduleMock).toHaveBeenCalledWith(
          'file:myproj:my-agent', '2h', 'do work', 'myproj', 'my-agent'
        );
      });
    })
});
