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

  describe('GET /agents', () => {
      it('returns empty list of agents initially', async () => {
        const request = new NextRequest('http://localhost/api/agents');
        const response = await GET(request);
        const data = await response.json();
  
        expect(data.agents).toEqual([]);
      });
  
      it('returns all agents', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-1',
            name: 'Agent 1',
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
            id: 'agent-2',
            name: 'Agent 2',
            project: 'proj2',
            skillIds: '["skill1"]',
            model: 'opus',
            prompt: 'Do something',
            schedule: '1h',
  
            createdAt: now,
            updatedAt: now,
          });
        await warmAgentsCache();
  
        const request = new NextRequest('http://localhost/api/agents');
        const response = await GET(request);
        const data = await response.json();
  
        expect(data.agents).toHaveLength(2);
        expect(data.agents[0].id).toBe('agent-1');
        expect(data.agents[1].id).toBe('agent-2');
      });
  
      it('filters agents by name', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents).values({ id: 'agent-1', name: 'Alpha', project: 'proj1', skillIds: '[]', model: 'sonnet', prompt: '', schedule: null, createdAt: now, updatedAt: now });
        await db.insert(schema.agents).values({ id: 'agent-2', name: 'Beta', project: 'proj1', skillIds: '[]', model: 'sonnet', prompt: '', schedule: null, createdAt: now, updatedAt: now });
        await warmAgentsCache();
  
        const request = new NextRequest('http://localhost/api/agents?name=Alpha');
        const response = await GET(request);
        const data = await response.json();
  
        expect(data.agents).toHaveLength(1);
        expect(data.agents[0].id).toBe('agent-1');
      });
  
      it('filters agents by project and name', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents).values({ id: 'agent-1', name: 'Alpha', project: 'proj1', skillIds: '[]', model: 'sonnet', prompt: '', schedule: null, createdAt: now, updatedAt: now });
        await db.insert(schema.agents).values({ id: 'agent-2', name: 'Alpha', project: 'proj2', skillIds: '[]', model: 'sonnet', prompt: '', schedule: null, createdAt: now, updatedAt: now });
        await warmAgentsCache();
  
        const request = new NextRequest('http://localhost/api/agents?project=proj1&name=Alpha');
        const response = await GET(request);
        const data = await response.json();
  
        expect(data.agents).toHaveLength(1);
        expect(data.agents[0].id).toBe('agent-1');
      });
  
      it('filters agents by project', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-1',
            name: 'Agent 1',
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
            id: 'agent-2',
            name: 'Agent 2',
            project: 'proj2',
            skillIds: '[]',
            model: 'sonnet',
            prompt: '',
            schedule: null,
  
            createdAt: now,
            updatedAt: now,
          });
        await warmAgentsCache();
  
        const request = new NextRequest('http://localhost/api/agents?project=proj1');
        const response = await GET(request);
        const data = await response.json();
  
        expect(data.agents).toHaveLength(1);
        expect(data.agents[0].id).toBe('agent-1');
      });
  
      it('merges file agents from all enabled projects on unfiltered GET', async () => {
        const db = testDb.db;
        await db.insert(schema.projects).values({ name: 'proj1', path: '/p1', enabled: true });
        await db.insert(schema.projects).values({ name: 'proj2', path: '/p2', enabled: true });
        await db.insert(schema.projects).values({ name: 'projDisabled', path: '/pd', enabled: false });
  
        scanFileAgentsMock.mockImplementation((path: string, project: string) => {
          if (project === 'proj1') {
            return [{
              id: 'file:proj1:fa1', name: 'fa1', project: 'proj1',
              skillIds: [], docPaths: [], model: 'sonnet', prompt: '', schedule: null,
   enabled: true, createdAt: 0, updatedAt: 0,
              source: 'file', filePath: `${path}/.tamtam/agents/fa1.md`,
            }];
          }
          if (project === 'proj2') {
            return [{
              id: 'file:proj2:fa2', name: 'fa2', project: 'proj2',
              skillIds: [], docPaths: [], model: 'sonnet', prompt: '', schedule: null,
   enabled: true, createdAt: 0, updatedAt: 0,
              source: 'file', filePath: `${path}/.tamtam/agents/fa2.md`,
            }];
          }
          return [];
        });
        await warmAgentsCache();
  
        const response = await GET(new NextRequest('http://localhost/api/agents'));
        const data = await response.json();
  
        const ids = data.agents.map((a: { id: string }) => a.id).sort();
        expect(ids).toEqual(['file:proj1:fa1', 'file:proj2:fa2']);
        // Disabled project must not be scanned
        const calledProjects = scanFileAgentsMock.mock.calls.map(c => c[1]);
        expect(calledProjects).not.toContain('projDisabled');
      });
  
      it('DB agent takes precedence over file agent with same project+name on unfiltered GET', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.projects).values({ name: 'proj1', path: '/p1', enabled: true });
        await db.insert(schema.agents).values({
          id: 'db-1', name: 'shared', project: 'proj1', skillIds: '[]',
          model: 'sonnet', prompt: 'db version', schedule: null,
          createdAt: now, updatedAt: now,
        });
  
        scanFileAgentsMock.mockReturnValue([{
          id: 'file:proj1:shared', name: 'shared', project: 'proj1',
          skillIds: [], docPaths: [], model: 'sonnet', prompt: 'file version', schedule: null,
   enabled: true, createdAt: 0, updatedAt: 0,
          source: 'file', filePath: '/p1/.tamtam/agents/shared.md',
        }]);
        await warmAgentsCache();
  
        const response = await GET(new NextRequest('http://localhost/api/agents'));
        const data = await response.json();
  
        expect(data.agents).toHaveLength(1);
        expect(data.agents[0].id).toBe('db-1');
        expect(data.agents[0].prompt).toBe('db version');
      });
  
      it('returns summary-only fields with live cron telemetry for fields=summary', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents).values({
          id: 'agent-summary',
          name: 'Summary Agent',
          project: 'proj1',
          skillIds: '["skill1"]',
          docPaths: '["docs/spec.md"]',
          model: 'sonnet',
          prompt: 'full prompt should stay out of summary responses',
          schedule: '15m',
          enabled: true,
          provider: 'codex',
          prerequisiteCommand: 'echo ready',
          createdAt: now,
          updatedAt: now,
        });
        loadAgentCronStatesMock.mockResolvedValueOnce(new Map([
          ['agent-summary', {
            agentId: 'agent-summary',
            nextFireMs: 123_000,
            attempts: 2,
            isAvailable: true,
            lockedAt: null,
            lastError: null,
          }],
        ]));
        getAllAgentLastAttemptsMock.mockReturnValueOnce(new Map([
          ['agent-summary', { at: 456_000, reason: 'jobs paused', status: 'skipped' }],
        ]));
        await warmAgentsCache();
  
        const response = await GET(new NextRequest('http://localhost/api/agents?fields=summary'));
        const data = await response.json();
  
        expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
        expect(data.agents).toEqual([{
          id: 'agent-summary',
          name: 'Summary Agent',
          project: 'proj1',
          schedule: '15m',
          enabled: true,
          model: 'normal',
          provider: 'codex',
          kind: 'user',
          source: 'db',
          cron: {
            nextFireMs: 123_000,
            attempts: 2,
            isAvailable: true,
            lockedAt: null,
            lastError: null,
          },
          lastAttempt: {
            at: 456_000,
            reason: 'jobs paused',
            status: 'skipped',
          },
        }]);
        expect(data.agents[0]).not.toHaveProperty('prompt');
        expect(data.agents[0]).not.toHaveProperty('skillIds');
        expect(data.agents[0]).not.toHaveProperty('docPaths');
        expect(data.agents[0]).not.toHaveProperty('prerequisiteCommand');
      });
  
      it('ignores fields=summary when a specific agent name requests full detail', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents).values({
          id: 'agent-detail',
          name: 'Detail Agent',
          project: 'proj1',
          skillIds: '["skill1"]',
          docPaths: '["docs/spec.md"]',
          model: 'sonnet',
          prompt: 'full prompt',
          schedule: '15m',
          enabled: true,
          provider: 'codex',
          prerequisiteCommand: 'echo ready',
          createdAt: now,
          updatedAt: now,
        });
        await warmAgentsCache();
  
        const response = await GET(new NextRequest('http://localhost/api/agents?fields=summary&name=Detail%20Agent'));
        const data = await response.json();
  
        expect(data.agents).toHaveLength(1);
        expect(data.agents[0]).toMatchObject({
          id: 'agent-detail',
          name: 'Detail Agent',
          prompt: 'full prompt',
          skillIds: ['skill1'],
          docPaths: ['docs/spec.md'],
          prerequisiteCommand: 'echo ready',
        });
      });
    });
});
