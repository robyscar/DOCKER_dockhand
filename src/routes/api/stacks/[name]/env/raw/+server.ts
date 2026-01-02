import { json } from '@sveltejs/kit';
import { getStacksDir } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestHandler } from './$types';

/**
 * GET /api/stacks/[name]/env/raw?env=X
 * Get the raw .env file content as-is (with comments, formatting, etc.)
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : null;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('stacks', 'view', envIdNum ?? undefined)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {
		const stackName = decodeURIComponent(params.name);
		const stacksDir = getStacksDir();
		const envFilePath = join(stacksDir, stackName, '.env');

		let content = '';
		if (existsSync(envFilePath)) {
			try {
				content = await Bun.file(envFilePath).text();
			} catch {
				// File read failed
			}
		}

		return json({ content });
	} catch (error) {
		console.error('Error getting raw env file:', error);
		return json({ error: 'Failed to get environment file' }, { status: 500 });
	}
};

/**
 * PUT /api/stacks/[name]/env/raw?env=X
 * Save raw .env file content directly to disk.
 * Body: { content: string }
 */
export const PUT: RequestHandler = async ({ params, url, cookies, request }) => {
	const auth = await authorize(cookies);
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : null;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('stacks', 'edit', envIdNum ?? undefined)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {
		const stackName = decodeURIComponent(params.name);
		const body = await request.json();

		if (typeof body.content !== 'string') {
			return json({ error: 'Invalid request body: content string required' }, { status: 400 });
		}

		const stacksDir = getStacksDir();
		const stackDir = join(stacksDir, stackName);
		const envFilePath = join(stackDir, '.env');

		// Only write if stack directory exists
		if (!existsSync(stackDir)) {
			return json({ error: 'Stack directory not found' }, { status: 404 });
		}

		let content = body.content;

		// If content is empty, delete the .env file instead of writing empty file
		if (!content || !content.trim()) {
			if (existsSync(envFilePath)) {
				rmSync(envFilePath);
				return json({ success: true, deleted: true });
			}
			return json({ success: true });
		}

		// Guard against writing masked secret placeholders (would corrupt the file)
		if (content.match(/^[A-Za-z_][A-Za-z0-9_]*=\*\*\*$/m)) {
			return json({
				error: 'Cannot write masked placeholder "***" to .env file - this would corrupt secret values'
			}, { status: 400 });
		}

		// Ensure content ends with newline
		if (!content.endsWith('\n')) {
			content += '\n';
		}

		await Bun.write(envFilePath, content);

		return json({ success: true });
	} catch (error) {
		console.error('Error saving raw env file:', error);
		return json({ error: 'Failed to save environment file' }, { status: 500 });
	}
};
