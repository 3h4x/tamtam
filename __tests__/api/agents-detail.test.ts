import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import * as schema from '@/lib/db/schema';
import { GET, POST, agentGET, PATCH, DELETE, PATCH_BY_NAME, describeAgentsApi } from './agents-fixtures';

describeAgentsApi((ctx) => {
  const { testDb } = ctx;

  describe('GET /agents/{agentId}', () => {
      it('returns 404 for nonexistent agent', async () => {
        const response = await agentGET(
          new NextRequest('http://localhost/api/agents/nonexistent'),
          { params: Promise.resolve({ agentId: 'nonexistent' }) }
        );
  
        expect(response.status).toBe(404);
        const data = await response.json();
        expect(data.detail).toBe('not found');
      });
  
      it('returns agent by ID', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-123',
            name: 'Test Agent',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: 'Do stuff',
            schedule: '1h',
  
            createdAt: now,
            updatedAt: now,
          });
  
        const response = await agentGET(
          new NextRequest('http://localhost/api/agents/agent-123'),
          { params: Promise.resolve({ agentId: 'agent-123' }) }
        );
  
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.agent.id).toBe('agent-123');
        expect(data.agent.name).toBe('Test Agent');
        expect(data.agent.project).toBe('proj1');
      });
  
      it('returns the effective issue-cruncher prerequisite when the stored row is blank', async () => {
        const now = Date.now() / 1000;
        await testDb.db.insert(schema.agents).values({
          id: 'agent-issue',
          name: 'Issue Cruncher',
          project: 'proj1',
          skillIds: '["agent-issue-cruncher"]',
          model: 'normal',
          prompt: '',
          schedule: null,
  
          prerequisiteCommand: null,
          createdAt: now,
          updatedAt: now,
        });
  
        const response = await agentGET(
          new NextRequest('http://localhost/api/agents/agent-issue'),
          { params: Promise.resolve({ agentId: 'agent-issue' }) }
        );
        const data = await response.json();
  
        expect(response.status).toBe(200);
        expect(data.agent.prerequisiteCommand).toBe(
          'curl -fsS "http://localhost:1337/api/projects/by-project/proj1/issues?pick_top=1"'
        );
      });
  
      it('keeps an explicitly cleared issue-cruncher prerequisite blank in GET responses', async () => {
        const now = Date.now() / 1000;
        await testDb.db.insert(schema.agents).values({
          id: 'agent-issue-cleared',
          name: 'Issue Cruncher',
          project: 'proj1',
          skillIds: '["agent-issue-cruncher"]',
          model: 'normal',
          prompt: '',
          schedule: null,
  
          prerequisiteCommand: '',
          createdAt: now,
          updatedAt: now,
        });
  
        const response = await agentGET(
          new NextRequest('http://localhost/api/agents/agent-issue-cleared'),
          { params: Promise.resolve({ agentId: 'agent-issue-cleared' }) }
        );
        const data = await response.json();
  
        expect(response.status).toBe(200);
        expect(data.agent.prerequisiteCommand).toBeNull();
      });
    });

  describe('agent revisions', () => {
    it('reverts a DB agent to a prior revision and records the revert', async () => {
      const { GET: revisionsGET } = await import('@/app/api/agents/[agentId]/revisions/route');
      const { POST: revertPOST } = await import('@/app/api/agents/[agentId]/revert/route');
      const now = Date.now() / 1000;
      await testDb.db.insert(schema.agents).values({
        id: 'agent-123',
        name: 'Test Agent',
        project: 'proj1',
        skillIds: '[]',
        model: 'sonnet',
        prompt: 'old prompt',
        schedule: null,
        createdAt: now,
        updatedAt: now,
      });

      const patchResponse = await PATCH(new NextRequest('http://localhost/api/agents/agent-123', {
        method: 'PATCH',
        body: JSON.stringify({ prompt: 'new prompt' }),
      }), { params: Promise.resolve({ agentId: 'agent-123' }) });
      expect(patchResponse.status).toBe(200);

      const listResponse = await revisionsGET(
        new NextRequest('http://localhost/api/agents/agent-123/revisions'),
        { params: Promise.resolve({ agentId: 'agent-123' }) },
      );
      const listData = await listResponse.json();
      expect(listData.revisions[0].parsedSnapshot.prompt).toBe('old prompt');

      const revertResponse = await revertPOST(new NextRequest('http://localhost/api/agents/agent-123/revert', {
        method: 'POST',
        body: JSON.stringify({ revisionId: listData.revisions[0].id }),
      }), { params: Promise.resolve({ agentId: 'agent-123' }) });
      const revertData = await revertResponse.json();

      expect(revertResponse.status).toBe(200);
      expect(revertData.agent.prompt).toBe('old prompt');
      const revisions = await testDb.db.select().from(schema.agentRevisions);
      expect(revisions).toHaveLength(2);
      expect(JSON.parse(revisions[1].snapshot).prompt).toBe('new prompt');
    });
  });
});
