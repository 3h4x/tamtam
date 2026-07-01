import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import * as schema from '@/lib/db/schema';
import { GET, POST, agentGET, PATCH, DELETE, PATCH_BY_NAME, describeAgentsApi } from './agents-fixtures';

describeAgentsApi((ctx) => {
  const {
    testDb,
    installAgentScheduleMock,
    uninstallAgentScheduleMock,
  } = ctx;

  describe('schedule installation', () => {
      it('calls installAgentSchedule when creating agent with schedule and prompt', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({
            name: 'Scheduled Agent',
            project: 'proj1',
            schedule: '1h',
            prompt: 'Do some work',
          }),
        });
  
        const response = await POST(request);
        expect(response.status).toBe(201);
        const data = await response.json();
  
        expect(installAgentScheduleMock).toHaveBeenCalledOnce();
        expect(installAgentScheduleMock).toHaveBeenCalledWith(
          data.agent.id,
          '1h',
          'Do some work',
          'proj1',
          'Scheduled Agent'
        );
      });
  
      it('does not call installAgentSchedule when creating agent with schedule but no prompt', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: 'Agent', project: 'proj1', schedule: '1h' }),
        });
  
        await POST(request);
        expect(installAgentScheduleMock).not.toHaveBeenCalled();
      });
  
      it('does not call installAgentSchedule when creating agent without schedule', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: 'Agent', project: 'proj1', prompt: 'Do work' }),
        });
  
        await POST(request);
        expect(installAgentScheduleMock).not.toHaveBeenCalled();
      });
  
      it('calls installAgentSchedule when creating skills-only agent (no prompt) with schedule', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({
            name: 'Skills Agent',
            project: 'proj1',
            schedule: '1h',
            skillIds: ['skill1'],
          }),
        });
  
        const response = await POST(request);
        expect(response.status).toBe(201);
        expect(installAgentScheduleMock).toHaveBeenCalledOnce();
      });
  
      it('does not call installAgentSchedule when creating agent with empty skills, no prompt, and schedule', async () => {
        const request = new NextRequest('http://localhost/api/agents', {
          method: 'POST',
          body: JSON.stringify({ name: 'Agent', project: 'proj1', schedule: '1h', skillIds: [] }),
        });
  
        await POST(request);
        expect(installAgentScheduleMock).not.toHaveBeenCalled();
      });
  
      it('calls installAgentSchedule when patching schedule on agent with prompt', async () => {
        const db = testDb.db;
        const now = Date.now() / 1000;
        await db.insert(schema.agents)
          .values({
            id: 'agent-123',
            name: 'Agent',
            project: 'proj1',
            skillIds: '[]',
            model: 'sonnet',
            prompt: 'existing prompt',
            schedule: null,
  
            createdAt: now,
            updatedAt: now,
          });
  
        const request = new NextRequest('http://localhost/api/agents/agent-123', {
          method: 'PATCH',
          body: JSON.stringify({ schedule: '2h' }),
        });
  
        await PATCH(request, { params: Promise.resolve({ agentId: 'agent-123' }) });
  
        expect(installAgentScheduleMock).toHaveBeenCalledOnce();
        expect(installAgentScheduleMock).toHaveBeenCalledWith(
          'agent-123',
          '2h',
          'existing prompt',
          'proj1',
          'Agent'
        );
      });
  
      it('calls uninstallAgentSchedule when patching schedule to empty', async () => {
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
          method: 'PATCH',
          body: JSON.stringify({ schedule: '' }),
        });
  
        await PATCH(request, { params: Promise.resolve({ agentId: 'agent-123' }) });
  
        expect(uninstallAgentScheduleMock).toHaveBeenCalledOnce();
        expect(uninstallAgentScheduleMock).toHaveBeenCalledWith('agent-123', 'proj1', 'Agent');
      });
  
      it('calls uninstallAgentSchedule when patching enabled to false', async () => {
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
          method: 'PATCH',
          body: JSON.stringify({ enabled: false }),
        });
  
        await PATCH(request, { params: Promise.resolve({ agentId: 'agent-123' }) });
  
        expect(uninstallAgentScheduleMock).toHaveBeenCalledOnce();
      });
  
    ;
  
      it('calls installAgentSchedule when patching enabled to true on agent with schedule and prompt', async () => {
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
  
            enabled: false,
            createdAt: now,
            updatedAt: now,
          });
  
        const request = new NextRequest('http://localhost/api/agents/agent-123', {
          method: 'PATCH',
          body: JSON.stringify({ enabled: true }),
        });
  
        await PATCH(request, { params: Promise.resolve({ agentId: 'agent-123' }) });
  
        expect(installAgentScheduleMock).toHaveBeenCalledOnce();
        expect(installAgentScheduleMock).toHaveBeenCalledWith(
          'agent-123',
          '1h',
          'do work',
          'proj1',
          'Agent'
        );
      });
  
      it('persists enabled field change in database', async () => {
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
          body: JSON.stringify({ enabled: false }),
        });
  
        await PATCH(request, { params: Promise.resolve({ agentId: 'agent-123' }) });
  
        const getResp = await agentGET(
          new NextRequest('http://localhost/api/agents/agent-123'),
          { params: Promise.resolve({ agentId: 'agent-123' }) }
        );
        const data = await getResp.json();
        expect(data.agent.enabled).toBe(false);
      });
    });
});
