import { describe, expect, it } from 'vitest';
import { setupProjectBoardTest } from './project-board-fixtures';

describe('project board ensure', () => {
  const { execMock } = setupProjectBoardTest();

  it('reuses an existing GitHub project and built-in Status field when all options are already present', async () => {
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'project' && args[1] === 'list') {
        return { exitCode: 0, stdout: JSON.stringify({ projects: [{ id: 'PVT_1', number: 7, title: 'TamTam' }] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            fields: [
              {
                id: 'FIELD_1',
                name: 'Status',
                options: [
                  { id: 'Q', name: 'Todo' },
                  { id: 'R', name: 'In Progress' },
                  { id: 'REV', name: 'Review' },
                  { id: 'F', name: 'Fixing' },
                  { id: 'B', name: 'Blocked' },
                  { id: 'D', name: 'Done' },
                ],
              },
              { id: 'F_PROJECT', name: 'Project' },
              { id: 'F_AGENT', name: 'Agent' },
              { id: 'F_KIND', name: 'Run kind' },
              { id: 'F_BRANCH', name: 'Branch' },
            ],
          }),
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { ensureProjectBoard } = await import('@/lib/github/project-board');
    const result = await ensureProjectBoard({ enabled: true, owner: 'octocat', title: 'TamTam' });

    expect(result).toEqual({
      owner: 'octocat',
      title: 'TamTam',
      projectNumber: '7',
      projectUrl: 'https://github.com/users/octocat/projects/7',
      projectId: 'PVT_1',
      statusFieldId: 'FIELD_1',
      optionIds: {
        'Todo': 'Q',
        'In Progress': 'R',
        'Review': 'REV',
        'Fixing': 'F',
        'Blocked': 'B',
        'Done': 'D',
      },
      customFieldIds: {
        project: 'F_PROJECT',
        agent: 'F_AGENT',
        kind: 'F_KIND',
        branch: 'F_BRANCH',
      },
    });
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it('creates the project and adds missing options to the built-in Status field via graphql', async () => {
    let fieldListCall = 0;
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'project' && args[1] === 'list') {
        return { exitCode: 0, stdout: JSON.stringify({ projects: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'create') {
        return { exitCode: 0, stdout: JSON.stringify({ id: 'PVT_NEW', number: 9, title: 'TamTam Ops' }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        fieldListCall++;
        if (fieldListCall === 1) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              fields: [{
                id: 'FIELD_NEW',
                name: 'Status',
                options: [
                  { id: 'OT', name: 'Todo' },
                  { id: 'OP', name: 'In Progress' },
                  { id: 'OD', name: 'Done' },
                ],
              }],
            }),
            stderr: '',
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            fields: [{
              id: 'FIELD_NEW',
              name: 'Status',
              options: [
                { id: 'OT', name: 'Todo' },
                { id: 'OP', name: 'In Progress' },
                { id: 'NREV', name: 'Review' },
                { id: 'NFIX', name: 'Fixing' },
                { id: 'NBLK', name: 'Blocked' },
                { id: 'OD', name: 'Done' },
              ],
            }],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        return { exitCode: 0, stdout: JSON.stringify({ data: { updateProjectV2Field: { projectV2Field: { id: 'FIELD_NEW' } } } }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'field-create') {
        const nameIdx = args.indexOf('--name');
        const name = nameIdx >= 0 ? args[nameIdx + 1] : '';
        const id = `F_${name.replace(/\s+/g, '_').toUpperCase()}`;
        return { exitCode: 0, stdout: JSON.stringify({ id, name }), stderr: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { ensureProjectBoard } = await import('@/lib/github/project-board');
    const result = await ensureProjectBoard({ enabled: true, owner: 'octocat', title: 'TamTam Ops' });

    expect(result.projectNumber).toBe('9');
    expect(result.projectId).toBe('PVT_NEW');
    expect(result.statusFieldId).toBe('FIELD_NEW');
    expect(result.projectUrl).toBe('https://github.com/users/octocat/projects/9');
    expect(result.optionIds).toEqual({
      'Todo': 'OT',
      'In Progress': 'OP',
      'Review': 'NREV',
      'Fixing': 'NFIX',
      'Blocked': 'NBLK',
      'Done': 'OD',
    });
    expect(result.customFieldIds).toEqual({
      project: 'F_PROJECT',
      agent: 'F_AGENT',
      kind: 'F_RUN_KIND',
      branch: 'F_BRANCH',
    });
    expect(execMock).toHaveBeenCalledTimes(9);
    const graphqlCall = execMock.mock.calls.find(([, args]) => Array.isArray(args) && args[0] === 'api' && args[1] === 'graphql');
    expect(graphqlCall).toBeDefined();
    const queryArg = String(graphqlCall![1][3] ?? '');
    expect(queryArg).toContain('updateProjectV2Field');
    expect(queryArg).toContain('"Review"');
    expect(queryArg).toContain('"Fixing"');
    expect(queryArg).toContain('"Blocked"');
  });

  it('fails clearly when gh project create returns an unparseable payload', async () => {
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'project' && args[1] === 'list') {
        return { exitCode: 0, stdout: JSON.stringify({ projects: [] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'create') {
        return { exitCode: 0, stdout: JSON.stringify({ project: null }), stderr: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { ensureProjectBoard } = await import('@/lib/github/project-board');
    await expect(ensureProjectBoard({ enabled: true, owner: 'octocat', title: 'TamTam' })).rejects.toThrow(
      'Failed to parse gh project create response',
    );
  });

  it('fails clearly when the built-in Status field is missing from the board', async () => {
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'project' && args[1] === 'list') {
        return { exitCode: 0, stdout: JSON.stringify({ projects: [{ id: 'PVT_1', number: 7, title: 'TamTam' }] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            fields: [{ id: 'F_PROJECT', name: 'Project' }],
          }),
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { ensureProjectBoard } = await import('@/lib/github/project-board');
    await expect(ensureProjectBoard({ enabled: true, owner: 'octocat', title: 'TamTam' })).rejects.toThrow(
      'Built-in Status field not found on project',
    );
  });

  it('fails clearly when the built-in Status field has no id and needs option upgrades', async () => {
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'project' && args[1] === 'list') {
        return { exitCode: 0, stdout: JSON.stringify({ projects: [{ id: 'PVT_1', number: 7, title: 'TamTam' }] }), stderr: '' };
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            fields: [{
              name: 'Status',
              options: [
                { id: 'Q', name: 'Todo' },
                { id: 'R', name: 'In Progress' },
                { id: 'D', name: 'Done' },
              ],
            }],
          }),
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const { ensureProjectBoard } = await import('@/lib/github/project-board');
    await expect(ensureProjectBoard({ enabled: true, owner: 'octocat', title: 'TamTam' })).rejects.toThrow(
      'Built-in Status field has no ID',
    );
  });
});
