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

	before(async () => {
		console.log('before');
		fixture = await loadFixture({
			root: './fixtures/with-svelte/',
		});
		console.log('after loadFixture');
		console.log('before build');
		try {
			console.log('before build try');
			await fixture.build({});
			console.log('after build try');
		} catch (error) {
			console.error('Unable to build fixture', error);
			throw error;
		}
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
