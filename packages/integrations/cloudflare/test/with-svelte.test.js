// @ts-check

import * as assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as cheerio from 'cheerio';
import { loadFixture } from './_test-utils.js';

describe('Svelte', () => {
	/** @type {import('../../../astro/test/test-utils.js').Fixture} */
	let fixture;
	/** @type {import('../../../astro/test/test-utils.js').PreviewServer} */
	let previewServer;

	async function fixtureBuild() {
		console.log(`[fixtureBuild] start`);
		let err;
		for (let attempt = 1; attempt <= 3; attempt++) {
			console.log(`[fixtureBuild] attempt: ${attempt}`);
			try {
				console.log(`[fixtureBuild] before build attempt ${attempt}`);
				await fixture.build({});
				console.log(`[fixtureBuild] after build attempt ${attempt}`);
				return;
			} catch (error) {
				console.log(`[fixtureBuild] catch error`);
				console.error(`Unable to build fixture for the attempt ${attempt}:`, error);
				err = new Error(`Unable to build fixture: ${error}`, { cause: error });
				console.log(`[fixtureBuild] after catch error`);
			}
		}
		console.log(`[fixtureBuild] after for loop`);
		if (err) {
			console.log(`[fixtureBuild] before throw err`);
			throw err;
		}
		console.log(`[fixtureBuild] after throw err`);
	}

	before(async () => {
		console.log('before');
		fixture = await loadFixture({
			root: './fixtures/with-svelte/',
		});
		console.log('after loadFixture');
		console.log('before build');
		await fixtureBuild();
		console.log('after build');
		console.log('before preview');
		previewServer = await fixture.preview({});
		console.log('after preview');
	});

	after(
		async () => {
			console.log('before stop', previewServer);
			console.log('before stop', previewServer.stop);
			await previewServer?.stop();
			console.log('after stop');
			try {
				console.log('before closed');
				// await previewServer.closed();
				console.log('after closed');
			} catch (error) {
				console.error('Unable to close preview server', error);
				throw error;
			}
			console.log('before clean');
			await fixture?.clean();
			console.log('after clean');
		},
		{
			timeout: 45_000,
		},
	);

	const run = async () => {
		console.log('before fetch');
		const res = await fixture.fetch('/');
		console.log('after fetch');
		assert.equal(res.status, 200);
		console.log('before text');
		const html = await res.text();
		console.log('after text');
		console.log('before load');
		const $ = cheerio.load(html);
		console.log('after load');
		console.log('before assert');
		const message = `Expected 'Svelte Content', but received the following HTML: ${html}`;
		assert.equal($('.svelte').text(), 'Svelte Content', message);
		console.log('after assert');
		return true;
	};

	it(
		'renders the svelte component',
		{
			timeout: 46_000,
		},
		async () => {
			await run();
		},
	);
});
