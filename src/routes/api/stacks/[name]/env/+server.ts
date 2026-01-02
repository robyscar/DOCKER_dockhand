import { json } from '@sveltejs/kit';
import { getStackEnvVars, setStackEnvVars } from '$lib/server/db';
import { getStacksDir } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestHandler } from './$types';

/**
 * Parse a .env file content into key-value pairs
 */
function parseEnvFile(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		// Skip empty lines and comments
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eqIndex = trimmed.indexOf('=');
		if (eqIndex > 0) {
			const key = trimmed.substring(0, eqIndex).trim();
			let value = trimmed.substring(eqIndex + 1);
			// Remove surrounding quotes if present
			if ((value.startsWith('"') && value.endsWith('"')) ||
			    (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			result[key] = value;
		}
	}
	return result;
}

/**
 * GET /api/stacks/[name]/env?env=X
 * Get all environment variables for a stack.
 * Merges variables from database with .env file (file values override for non-secrets).
 *
 * SECURITY: Secrets are returned as '***' (masked) - they are NEVER sent in plain text.
 * Secrets are stored only in the database and injected via shell environment at runtime.
 * The .env file only contains non-secret variables.
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

		// Get variables from database (masked - secrets show as '***')
		const dbVariables = await getStackEnvVars(stackName, envIdNum, true);
		const dbByKey = new Map(dbVariables.map(v => [v.key, v]));

		// Try to read .env file from stack directory (only contains non-secrets)
		const stacksDir = getStacksDir();
		const envFilePath = join(stacksDir, stackName, '.env');
		let fileVars: Record<string, string> = {};

		if (existsSync(envFilePath)) {
			try {
				const content = await Bun.file(envFilePath).text();
				fileVars = parseEnvFile(content);
			} catch (e) {
				// Ignore file read errors
			}
		}

		// Merge: DB variables (with secrets masked) + file variables (non-secrets only)
		// For non-secrets: file value overrides DB value (user may have edited file)
		// For secrets: only DB value exists (masked as '***')
		const mergedKeys = new Set([...dbByKey.keys(), ...Object.keys(fileVars)]);
		const variables: { key: string; value: string; isSecret: boolean }[] = [];

		for (const key of mergedKeys) {
			const dbVar = dbByKey.get(key);
			const fileValue = fileVars[key];

			if (dbVar) {
				if (dbVar.isSecret) {
					// Secret: use masked value from DB, ignore any file value
					variables.push({ key, value: dbVar.value, isSecret: true });
				} else if (fileValue !== undefined) {
					// Non-secret with file value: file overrides (user may have edited)
					variables.push({ key, value: fileValue, isSecret: false });
				} else {
					// Non-secret only in DB: use DB value
					variables.push({ key, value: dbVar.value, isSecret: false });
				}
			} else if (fileValue !== undefined) {
				// Variable only in file - add it as non-secret
				variables.push({ key, value: fileValue, isSecret: false });
			}
		}

		return json({ variables });
	} catch (error) {
		console.error('Error getting stack env vars:', error);
		return json({ error: 'Failed to get environment variables' }, { status: 500 });
	}
};

/**
 * PUT /api/stacks/[name]/env?env=X
 * Set/replace all environment variables for a stack.
 * Body: { variables: [{ key, value, isSecret? }] }
 *
 * SECURITY: Secrets are stored ONLY in the database, NEVER written to .env file.
 * For secrets, if the value is '***' (the masked placeholder), the original
 * secret value from the database is preserved instead of overwriting with '***'.
 *
 * The .env file only contains non-secret variables (can be edited manually).
 * Secrets are injected via shell environment variables at runtime.
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

		if (!body.variables || !Array.isArray(body.variables)) {
			return json({ error: 'Invalid request body: variables array required' }, { status: 400 });
		}

		// Validate variables
		for (const v of body.variables) {
			if (!v.key || typeof v.key !== 'string') {
				return json({ error: 'Invalid variable: key is required and must be a string' }, { status: 400 });
			}
			if (typeof v.value !== 'string') {
				return json({ error: `Invalid variable "${v.key}": value must be a string` }, { status: 400 });
			}
			// Validate key format (env var naming convention)
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key)) {
				return json({ error: `Invalid variable name "${v.key}": must start with a letter or underscore and contain only alphanumeric characters and underscores` }, { status: 400 });
			}
		}

		// Check if any secrets have the masked placeholder '***'
		// If so, we need to preserve their original values from the database
		const secretsWithMaskedValue = body.variables.filter(
			(v: { key: string; value: string; isSecret?: boolean }) =>
				v.isSecret && v.value === '***'
		);

		let variablesToSave = body.variables;

		if (secretsWithMaskedValue.length > 0) {
			// Get existing variables (unmasked) to preserve secret values
			const existingVars = await getStackEnvVars(stackName, envIdNum, false);
			const existingByKey = new Map(existingVars.map(v => [v.key, v]));

			// Replace masked secrets with their original values
			variablesToSave = body.variables.map((v: { key: string; value: string; isSecret?: boolean }) => {
				if (v.isSecret && v.value === '***') {
					const existing = existingByKey.get(v.key);
					if (existing && existing.isSecret) {
						// Preserve the original secret value
						return { ...v, value: existing.value };
					}
				}
				return v;
			});
		}

		// Save ALL variables (including secrets) to database
		// Note: The .env file is written by PUT /env/raw endpoint, which preserves comments
		await setStackEnvVars(stackName, envIdNum, variablesToSave);

		return json({ success: true, count: variablesToSave.length });
	} catch (error) {
		console.error('Error setting stack env vars:', error);
		return json({ error: 'Failed to set environment variables' }, { status: 500 });
	}
};
