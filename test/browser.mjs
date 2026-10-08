/**
 * Real-browser, real-server test.
 *
 *   node test/browser.mjs <base-url> [workspace-cwd]
 *
 * Everything else in `test/` fakes some layer. This one fakes nothing: it
 * loads the actual GUI in Chromium against a booted `dsh web`, lets the real
 * module loader materialize the real bundle, and dispatches real `DragEvent`s
 * carrying real `File`s. The assertions are on the two places the result is
 * actually observable — the composer draft and the file on disk.
 *
 * Point it at a throwaway instance, not the one you are using: a successful
 * drop writes a real file into the session's drop directory.
 *
 * It types no prompt and sends nothing.
 */

import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = process.argv[2];
const workspace = process.argv[3] ?? process.cwd();
if (base === undefined) throw new Error('usage: node test/browser.mjs <base-url> [workspace-cwd]');

/** Prefer the system Chromium; override with CHROME_PATH. */
const executablePath = process.env.CHROME_PATH ?? '/usr/bin/chromium-browser';

/** Unique per run so a previous run's file can never satisfy this one. */
const probeName = `dsh-drop-probe-${String(Date.now())}.pdf`;
const probeText = 'payload from a real browser drag';
const probePath = join(workspace, '.dsh-drops', probeName);

const browser = await puppeteer.launch({
	executablePath,
	headless: true,
	args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
});

/** Poll until `check` passes or the budget runs out. */
const until = async (check, label, budgetMs = 8000) => {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		if (await check()) return;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
};

try {
	const page = await browser.newPage();
	const bundleUrls = [];
	const pageErrors = [];
	page.on('response', (response) => {
		if (response.url().includes('dsh-drop-reference')) bundleUrls.push(response.url());
	});
	page.on('pageerror', (error) => pageErrors.push(error.message));

	await page.goto(base, { waitUntil: 'networkidle2', timeout: 90_000 });
	// The plugin roster is applied asynchronously after first paint, and the
	// composer only renders once a session is selected.
	await new Promise((resolve) => setTimeout(resolve, 4000));
	await page.waitForSelector('textarea', { timeout: 30_000 });

	/** Read the composer draft straight off the textarea the composer renders. */
	const readDraft = () => page.$eval('textarea', (node) => node.value);

	/** Dispatch a real drop and report whether the page cancelled the default. */
	const drop = (entries) =>
		page.evaluate((specs) => {
			const files = specs.map((spec) => new File([new Blob([spec.text])], spec.name, { type: spec.type }));
			const transfer = new DataTransfer();
			for (const file of files) transfer.items.add(file);
			const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
			document.dispatchEvent(event);
			return event.defaultPrevented;
		}, entries);

	// The browser half must have arrived and been executed by the page.
	assert.ok(
		bundleUrls.some((url) => url.includes('/client.js')),
		`the client bundle was never requested; saw: ${JSON.stringify(bundleUrls)}`
	);
	assert.deepEqual(pageErrors, [], 'the page must load without errors');

	const draftBefore = await readDraft();

	// ── a non-image drop becomes an @ reference ─────────────────────────────

	const prevented = await drop([{ name: probeName, type: 'application/pdf', text: probeText }]);
	assert.equal(prevented, true, 'the drop must be intercepted rather than left to navigate the page');

	await until(async () => (await readDraft()).includes(`@.dsh-drops/${probeName}`), 'the @ reference to reach the composer');

	const draftAfter = await readDraft();
	assert.ok(
		draftAfter.startsWith(draftBefore),
		`the mention must be appended, not replace the draft: ${JSON.stringify({ draftBefore, draftAfter })}`
	);

	// The reference is only honest if the bytes are really on disk.
	const written = await readFile(probePath, 'utf8');
	assert.equal(written, probeText, 'the host must have written the exact dropped bytes');

	// ── an image drop still belongs to the attachment pipeline ──────────────

	const draftBeforeImage = await readDraft();
	await drop([{ name: 'shot.png', type: 'image/png', text: 'not really a png' }]);
	await new Promise((resolve) => setTimeout(resolve, 1000));
	assert.equal(await readDraft(), draftBeforeImage, 'an image drop must not add an @ reference');

	console.log('drop-reference real browser: ok');
	console.log(`  bundle served : ${bundleUrls[0]}`);
	console.log(`  dropped file  : ${probePath}`);
	console.log(`  draft gained  : ${JSON.stringify(draftAfter.slice(draftBefore.length))}`);
} finally {
	await browser.close();
	await rm(probePath, { force: true });
}
