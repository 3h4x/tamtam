import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import * as schema from '@/lib/db/schema';
import { setupSettingsApiTest } from '@/__tests__/api/settings-fixtures';
import { verifyAuthToken } from '@/lib/auth/token';

const ctx = setupSettingsApiTest();

describe('PATCH /settings validation', () => {

    it('rejects invalid plain test phase flag values', async () => {
      const response = await ctx.PATCH(new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ plain_test_phase_enabled: 'sometimes' }),
      }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        detail: 'plain_test_phase_enabled must be true or false.',
      });
      expect(await ctx.sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });

    it('rejects invalid auto-fix-ci-on-red-default-branch flag values', async () => {
      const response = await ctx.PATCH(new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ auto_fix_ci_on_red_default_branch: 'maybe' }),
      }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        detail: 'auto_fix_ci_on_red_default_branch must be true or false.',
      });
      expect(await ctx.sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });

    it('persists auto-fix-ci-on-red-default-branch when set to true', async () => {
      const response = await ctx.PATCH(new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ auto_fix_ci_on_red_default_branch: 'true' }),
      }));
      expect(response.status).toBe(200);
      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      expect(rows.find((r) => r.key === 'auto_fix_ci_on_red_default_branch')?.value).toBe('true');
    });

    it('hashes auth_token and rejects short tokens', async () => {
      const bad = await ctx.PATCH(new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ auth_token: 'short' }),
      }));
      expect(bad.status).toBe(400);
      await expect(bad.json()).resolves.toMatchObject({
        detail: 'auth_token must be at least 32 characters.',
      });

      const token = '0123456789abcdef0123456789abcdef';
      const good = await ctx.PATCH(new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ auth_token: token }),
      }));
      expect(good.status).toBe(200);
      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      const stored = rows.find((row) => row.key === 'auth_token')?.value ?? '';
      expect(stored).toMatch(/^scrypt:v1:/);
      expect(stored).not.toContain(token);
      expect(verifyAuthToken(token, stored)).toBe(true);
      await expect(good.json()).resolves.toMatchObject({
        settings: { auth_token_configured: 'true' },
      });
    });


    it('rejects invalid retrieval settings', async () => {
      const response = await ctx.PATCH(new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          retrieval_score_threshold: '1.5',
        }),
      }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('retrieval_score_threshold'),
      });
      expect(await ctx.sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });


    it('rejects invalid permission_mode values', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ permission_mode: 'dangerousMode' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.detail).toContain('permission_mode must be one of');
    });


    it('rejects invalid default_model values', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ default_model: 'smart --resume injected' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('Invalid model'),
      });
      expect(await ctx.sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });


    it('rejects invalid pipeline model overrides', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ pipeline_model_review: 'normal --danger' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('Invalid model'),
      });
      expect(await ctx.sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });


    it('rejects duplicate trusted_github_users before persisting them', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ trusted_github_users: 'octocat, OctoCat' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: 'Duplicate GitHub login: OctoCat',
      });
      expect(await ctx.sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });


    it('rejects trusted_github_users entries with empty rows', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ trusted_github_users: 'octocat,\n, hubot' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: 'Trusted GitHub users cannot be empty.',
      });
      expect(await ctx.sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });


    it('rejects negative workflow run retention settings', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ workflow_run_retention_days: '-1' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('workflow_run_retention_days must be a non-negative integer'),
      });
      expect(await ctx.sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });


    it('rejects negative backup retention settings', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ backup_retention_count: '-1' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('backup_retention_count must be a non-negative integer'),
      });
      expect(await ctx.sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });


    it('rejects negative revision retention settings', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ skill_revision_retention_count: '-1' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('skill_revision_retention_count must be a non-negative integer'),
      });
      expect(await ctx.sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });


    it('rejects non-numeric fix_max_iterations values', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ fix_max_iterations: 'abc' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('fix_max_iterations must be a non-negative integer'),
      });
      expect(await ctx.sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });


    it('rejects negative fix_max_iterations values', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ fix_max_iterations: '-1' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('fix_max_iterations must be a non-negative integer'),
      });
      expect(await ctx.sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });


    it('rejects invalid review_do_not_ship_action values', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ review_do_not_ship_action: 'ship-it' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('review_do_not_ship_action must be one of: pass, fix, abort'),
      });
      expect(await ctx.sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });


    it('rejects out-of-range retrieval_reindex_interval_hours values', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ retrieval_reindex_interval_hours: '169' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('retrieval_reindex_interval_hours must be a positive integer between 1 and 168'),
      });
      expect(await ctx.sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });


    it('rejects a non-positive-integer mark_dod_verify_timeout_ms', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ mark_dod_verify_timeout_ms: 'soon' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('mark_dod_verify_timeout_ms must be a positive integer'),
      });
      expect(await ctx.sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });


    it('persists a valid mark_dod_verify_timeout_ms', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ mark_dod_verify_timeout_ms: '300000' }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(200);
      const rows = await ctx.sharedHandle.db.select().from(schema.settings);
      expect(rows.find((r) => r.key === 'mark_dod_verify_timeout_ms')?.value).toBe('300000');
    });


    it('rejects agent_templates with invalid model values', async () => {
      const templates = [
        { name: 'security-review', description: 'Scans for OWASP issues', model: 'smart --resume injected', schedule: '24h', prompt: 'Review the diff for security issues.' },
      ];
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ agent_templates: JSON.stringify(templates) }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: expect.stringContaining('Invalid model'),
      });
      expect(await ctx.sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });


    it('rejects non-object notification_throttle_overrides payloads', async () => {
      const request = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          notification_throttle_overrides: JSON.stringify(['release_fail']),
        }),
      });
      const response = await ctx.PATCH(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        detail: 'notification_throttle_overrides must be a JSON object.',
      });
      expect(await ctx.sharedHandle.db.select().from(schema.settings)).toEqual([]);
    });
});
