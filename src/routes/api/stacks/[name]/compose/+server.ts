import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStackComposeFile, deployStack, saveStackComposeFile } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';

// GET /api/stacks/[name]/compose - Get compose file content
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('stacks', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const { name } = params;

	try {
		const result = await getStackComposeFile(name);

		if (!result.success) {
			return json({ error: result.error }, { status: 404 });
		}

		return json({ content: result.content, stackDir: result.stackDir });
	} catch (error: any) {
		console.error(`Error getting compose file for stack ${name}:`, error);
		return json({ error: error.message || 'Failed to get compose file' }, { status: 500 });
	}
};

// PUT /api/stacks/[name]/compose - Update compose file content
export const PUT: RequestHandler = async ({ params, request, url, cookies }) => {
	const auth = await authorize(cookies);

	const { name } = params;
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !(await auth.can('stacks', 'edit', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const { content, restart = false } = body;

		if (!content || typeof content !== 'string') {
			return json({ error: 'Compose file content is required' }, { status: 400 });
		}

		let result;
		if (restart) {
			// Deploy with docker compose up -d (only recreates changed services)
			result = await deployStack({
				name,
				compose: content,
				envId: envIdNum
			});
		} else {
			// Just save the file without restarting
			result = await saveStackComposeFile(name, content);
		}

		if (!result.success) {
			return json({ error: result.error }, { status: 500 });
		}

		return json({ success: true });
	} catch (error: any) {
		console.error(`Error updating compose file for stack ${name}:`, error);
		return json({ error: error.message || 'Failed to update compose file' }, { status: 500 });
	}
};
