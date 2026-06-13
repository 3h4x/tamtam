import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import * as schema from '@/lib/db/schema';
import { setupSettingsApiTest, ensureProjectBoardMock } from '@/__tests__/api/settings-fixtures';

const ctx = setupSettingsApiTest();

describe('PATCH /settings integrations', () => {

    it('configures GitHub board settings when sync is enabled', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          github_owner: 'octocat',
          github_board_sync_enabled: 'true',
          github_board_project_owner: 'octocat',
          github_board_project_title: 'TamTam',
        }),
      });

      const response = await ctx.PATCH(request);

      expect(response.status).toBe(200);
      expect(ensureProjectBoardMock).toHaveBeenCalledWith({
        enabled: true,
        owner: 'octocat',
        title: 'TamTam',
      });
      const allRows = await ctx.sharedHandle.db.select().from(schema.settings);
      const rows = Object.fromEntries(allRows.map((row) => [row.key, row.value]));
      expect(rows.github_board_project_number).toBe('7');
      expect(rows.github_board_project_id).toBe('PVT_x');
      expect(rows.github_board_status_field_id).toBe('F_x');
      expect(rows.github_board_status_option_ids).toContain('"In Progress":"2"');
    });


    it('persists github_board_status_option_ids as JSON when given an object', async () => {
      const optionIds = { 'Todo': 'Q', 'In Progress': 'R', 'Review': 'REV', 'Fixing': 'F', 'Blocked': 'B', 'Done': 'D' };
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ github_board_status_option_ids: optionIds }),
      });
      await ctx.PATCH(request);

      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const row = rows.find(r => r.key === 'github_board_status_option_ids');
      expect(row?.value).toBe(JSON.stringify(optionIds));
      expect(JSON.parse(row!.value)).toEqual(optionIds);
    });


    it('round-trips github_board_status_option_ids through GET', async () => {
      const optionIds = { 'Todo': 'Q', 'In Progress': 'R' };
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'github_board_status_option_ids', value: JSON.stringify(optionIds) });
      const response = await ctx.GET();
      const data = await response.json();
      expect(JSON.parse(data.settings.github_board_status_option_ids)).toEqual(optionIds);
    });


    it('round-trips github_board_custom_field_ids through GET', async () => {
      const customFieldIds = { project: 'P', agent: 'A', kind: 'K', branch: 'B' };
      await ctx.sharedHandle.db.insert(schema.settings).values({ key: 'github_board_custom_field_ids', value: JSON.stringify(customFieldIds) });

      const response = await ctx.GET();
      const data = await response.json();

      expect(JSON.parse(data.settings.github_board_custom_field_ids)).toEqual(customFieldIds);
    });


    it('returns 502 when enabling GitHub board sync fails', async () => {
      ensureProjectBoardMock.mockRejectedValueOnce(new Error('missing project scope'));
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          github_board_sync_enabled: 'true',
          github_board_project_owner: 'octocat',
        }),
      });

      const response = await ctx.PATCH(request);

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({ detail: 'missing project scope' });
    });

    it('calls reloadConfig after saving settings', async () => {
      // Spy on the real reloadConfig in @/lib/shared/config. The settings
      // route imports it via a live ESM binding so the spy intercepts the
      // call without needing vi.resetModules() / vi.doMock().
      const configMod = await import('@/lib/shared/config');
      const spy = vi.spyOn(configMod, 'reloadConfig');
      try {
        const request = new NextRequest('http://localhost/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({ workspace_path: '/new/path' }),
        });
        await ctx.PATCH(request);

        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
});
