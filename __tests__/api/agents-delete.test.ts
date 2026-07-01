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

  describe('DELETE /agents/{agentId}', () => {
      it('deletes agent by ID', async () => {
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
          method: 'DELETE',
        });
  
        const response = await DELETE(request, {
          params: Promise.resolve({ agentId: 'agent-123' }),
        });
  
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe('deleted');
      });
  
      it('returns success even if agent does not exist', async () => {
        const request = new NextRequest('http://localhost/api/agents/nonexistent', {
          method: 'DELETE',
        });
  
        const response = await DELETE(request, {
          params: Promise.resolve({ agentId: 'nonexistent' }),
        });
  
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe('deleted');
      });
  
      it('agent is gone after delete', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-del',
            name: 'To Delete',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: '',
            schedule: null,
  
            createdAt: now,
            updatedAt: now,
          });
  
        const deleteReq = new NextRequest('http://localhost/api/agents/agent-del', {
          method: 'DELETE',
        });
        await DELETE(deleteReq, { params: Promise.resolve({ agentId: 'agent-del' }) });
  
        const getResp = await agentGET(
          new NextRequest('http://localhost/api/agents/agent-del'),
          { params: Promise.resolve({ agentId: 'agent-del' }) }
        );
        expect(getResp.status).toBe(404);
      });
  
      it('calls uninstallAgentSchedule when deleting', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-123',
            name: 'Agent',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: 'do work',
            schedule: '1h',
  
            createdAt: now,
            updatedAt: now,
          });
  
        const request = new NextRequest('http://localhost/api/agents/agent-123', {
          method: 'DELETE',
        });
        await DELETE(request, { params: Promise.resolve({ agentId: 'agent-123' }) });
  
        expect(uninstallAgentScheduleMock).toHaveBeenCalledOnce();
        expect(uninstallAgentScheduleMock).toHaveBeenCalledWith('agent-123', 'proj1', 'Agent');
      });
    });
});
