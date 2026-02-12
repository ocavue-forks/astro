import { getTsconfig, parseTsconfig } from 'get-tsconfig';
import { parse as parseJsonc } from 'jsonc-parser';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompilerOptions, TypeAcquisition } from 'typescript';

export const defaultTSConfig: TSConfig = { extends: 'astro/tsconfigs/base' };

export type frameworkWithTSSettings = 'vue' | 'react' | 'preact' | 'solid-js';
// The following presets unfortunately cannot be inside the specific integrations, as we need
// them even in cases where the integrations are not installed
export const presets = new Map<frameworkWithTSSettings, TSConfig>([
	[
		'vue', // Settings needed for template intellisense when using Volar
		{
			compilerOptions: {
				jsx: 'preserve',
			},
		},
	],
	[
		'react', // Default TypeScript settings, but we need to redefine them in case the users changed them previously
		{
			compilerOptions: {
				jsx: 'react-jsx',
				jsxImportSource: 'react',
			},
		},
	],
	[
		'preact', // https://preactjs.com/guide/v10/typescript/#typescript-configuration
		{
			compilerOptions: {
				jsx: 'react-jsx',
				jsxImportSource: 'preact',
			},
		},
	],
	[
		'solid-js', // https://www.solidjs.com/guides/typescript#configuring-typescript
		{
			compilerOptions: {
				jsx: 'preserve',
				jsxImportSource: 'solid-js',
			},
		},
	],
]);

type TSConfigResult<T = object> = Promise<
	| ({
			/**
			 * absolute path to parsed tsconfig.json
			 */
			tsconfigFile: string;

			/**
			 * parsed result, including merged values from extended
			 */
			tsconfig: TSConfig;
	  } & T)
	| 'invalid-config'
	| 'missing-config'
	| 'unknown-error'
>;

/**
 * Load a tsconfig.json or jsconfig.json if the former is not found
 * @param root The root directory to search in, defaults to `process.cwd()`.
 * @param findUp Whether to search for the config file in parent directories, by default only the root directory is searched.
 */
export async function loadTSConfig(
	root: string | undefined,
	findUp = false,
): Promise<TSConfigResult<{ rawConfig: TSConfig }>> {
	const safeCwd = root ?? process.cwd();
	for (const configName of ['tsconfig.json', 'jsconfig.json']) {
		const result = safeLoadTSConfig(safeCwd, configName, findUp);
		if (result === 'missing-config') {
			continue;
		}
		if (result === 'invalid-config') {
			return 'invalid-config';
		}
		const { tsconfig, tsconfigFile } = result;
		const rawConfig = await safeLoadRawTSConfig(tsconfigFile);
		if (rawConfig === 'unknown-error') {
			return 'unknown-error';
		}
		return { tsconfig, tsconfigFile, rawConfig };
	}
	return 'missing-config';
}

function safeLoadTSConfig(
	cwd: string,
	configName: string,
	findUp: boolean,
):
	| {
			tsconfig: TSConfig;
			tsconfigFile: string;
	  }
	| 'invalid-config'
	| 'missing-config' {
	try {
		if (findUp) {
			const result = getTsconfig(cwd, configName);
			if (!result) {
				return 'missing-config';
			}
			return {
				tsconfig: result.config,
				tsconfigFile: result.path,
			};
		} else {
			const tsconfigFile = join(cwd, configName);
			if (!existsSync(tsconfigFile)) {
				return 'missing-config';
			}
			const tsconfig = parseTsconfig(tsconfigFile);
			return {
				tsconfig,
				tsconfigFile,
			};
		}
	} catch {
		return 'invalid-config';
	}
}

async function safeLoadRawTSConfig(tsconfigPath: string): Promise<TSConfig | 'unknown-error'> {
	try {
		const fileContent = await readFile(tsconfigPath, 'utf-8');
		return parseJsonc(fileContent);
	} catch {
		return 'unknown-error';
	}
}

export function updateTSConfigForFramework(
	target: TSConfig,
	framework: frameworkWithTSSettings,
): TSConfig {
	if (!presets.has(framework)) {
		return target;
	}

	return deepMergeObjects(target, presets.get(framework)!);
}

// Simple deep merge implementation that merges objects and strings
function deepMergeObjects<T extends Record<string, any>>(a: T, b: T): T {
	const merged: T = { ...a };

	for (const key in b) {
		const value = b[key];

		if (a[key] == null) {
			merged[key] = value;
			continue;
		}

		if (typeof a[key] === 'object' && typeof value === 'object') {
			merged[key] = deepMergeObjects(a[key], value);
			continue;
		}

		merged[key] = value;
	}

	return merged;
}

// The code below is adapted from `pkg-types`
// `pkg-types` offer more types and utilities, but since we only want the TSConfig type, we'd rather avoid adding a dependency.
// https://github.com/unjs/pkg-types/blob/78328837d369d0145a8ddb35d7fe1fadda4bfadf/src/types/tsconfig.ts
// See https://github.com/unjs/pkg-types/blob/78328837d369d0145a8ddb35d7fe1fadda4bfadf/LICENSE for license information

type StripEnums<T extends Record<string, any>> = {
	[K in keyof T]: T[K] extends boolean
		? T[K]
		: T[K] extends string
			? T[K]
			: T[K] extends object
				? T[K]
				: T[K] extends Array<any>
					? T[K]
					: T[K] extends undefined
						? undefined
						: any;
};

export interface TSConfig {
	compilerOptions?: StripEnums<CompilerOptions>;
	compileOnSave?: boolean;
	extends?: string;
	files?: string[];
	include?: string[];
	exclude?: string[];
	typeAcquisition?: TypeAcquisition;
}
