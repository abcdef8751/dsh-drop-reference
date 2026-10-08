/**
 * Browser-half test. Run with: node test/client.mjs
 *
 * The client bundle is a classic script that only talks to the page through
 * `window.__ModuleLoader__`, so it can be loaded into a bare VM with no DOM at
 * all. That makes the parts worth testing — descriptor shape, drop
 * interception, mention spelling, error reporting — verifiable without a
 * browser.
 *
 * `DataTransfer` and `DragEvent` do not exist in Node, which is deliberate
 * here: the overlay-cleanup path runs its `catch` branch and the test asserts
 * the drop still succeeds through it.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));

/** Drop listeners the bundle registers on `window`, keyed by event name. */
const listeners = new Map();

/** Load the bundle the way the page does, capturing its registration record. */
async function loadBundle() {
	const source = await readFile(bundlePath, 'utf8');
	let record;
	const sandbox = {
		console,
		btoa,
		File,
		Blob,
		window: {
			__ModuleLoader__: {
				load(value) {
					record = value;
				}
			},
			addEventListener(name, handler) {
				listeners.set(name, handler);
			},
			removeEventListener(name) {
				listeners.delete(name);
			}
		}
	};
	sandbox.globalThis = sandbox;
	vm.runInNewContext(source, sandbox, { filename: bundlePath });
	if (record === undefined) throw new Error('the bundle never called window.__ModuleLoader__.load');
	return { record, sandbox };
}

/** A ctx with just the surface `apply` touches. */
function fakeContext({ sessionId = 'session-1', commit } = {}) {
	const state = { draft: '', notices: [], commits: [], listeners };
	const shell = {
		get snapshot() {
			return { draft: state.draft };
		},
		setDraft(next) {
			state.draft = next;
		},
		notify(level, text) {
			state.notices.push({ level, text });
		}
	};
	const ctx = {
		remote: {
			async $mount(contribution) {
				state.contribution = contribution;
				return () => {};
			},
			dropFiles: {
				async commit(...args) {
					state.commits.push(args);
					return commit(...args);
				}
			}
		},
		get(key) {
			if (key === 'sessions') return { list: { getSnapshot: () => ({ current: sessionId }) } };
			if (key === 'conversation') return { input: { shell: () => shell } };
			if (key === 'remote.dropFiles') return ctx.remote.dropFiles;
			return undefined;
		},
		effect(callback) {
			const dispose = callback();
			state.effectDispose = dispose;
			return dispose;
		}
	};
	return { ctx, state, shell };
}

/** Minimal File stand-in: `type` and `arrayBuffer()` are all the bundle uses. */
const fakeFile = (name, type, text) => ({
	name,
	type,
	size: text.length,
	async arrayBuffer() {
		return new TextEncoder().encode(text).buffer;
	}
});

const event = (files) => {
	let stopped = false;
	let prevented = false;
	return {
		files,
		get stopped() {
			return stopped;
		},
		get prevented() {
			return prevented;
		},
		dataTransfer: { types: ['Files'], files },
		stopPropagation() {
			stopped = true;
		},
		preventDefault() {
			prevented = true;
		}
	};
};

/** Let the fire-and-forget handler settle. */
const settle = async (predicate) => {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
};

// ── package metadata the modules node half scans ────────────────────────────

const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
assert.equal(manifest.dsh.client.platform, 'web');
assert.equal(manifest.exports['./client'], './lib/client.js');

// ── bundle registration ────────────────────────────────────────────────────

const { record } = await loadBundle();
assert.equal(record.id, manifest.name, 'the bundle id must match the package name');
const clientModule = record.factory(() => {
	throw new Error('the drop-reference client bundle must not require any module');
});
assert.equal(typeof clientModule.apply, 'function');
assert.deepEqual([...clientModule.inject], ['remote', 'sessions', 'conversation']);

// ── descriptor shape accepted by ctx.remote.$mount ─────────────────────────

const { ctx, state, shell } = fakeContext({
	commit: async (_agent, name) => ({ ok: true, value: { path: `/tmp/.dsh-drops/${name}`, mention: `.dsh-drops/${name}` } })
});
await clientModule.apply(ctx);
const [descriptor] = state.contribution.descriptors;
assert.equal(state.contribution.package, manifest.name);
assert.equal(descriptor.namespace, 'dropFiles');
assert.equal(descriptor.method, 'commit');
assert.equal(descriptor.parameters[0].source, 'lookup', 'the agent parameter must resolve host-side');
assert.equal(descriptor.parameters[0].wire, 'agentId');
for (const codec of [descriptor.result, ...descriptor.parameters.map((parameter) => parameter.codec)]) {
	assert.equal(codec.mode, 'strict');
	assert.ok(codec.typeSymbol.length > 0, 'strict codecs need a nonempty type symbol');
	assert.equal(typeof codec.schema.parse, 'function');
}

// ── drop interception ──────────────────────────────────────────────────────

const onDrop = state.listeners.get('drop');
assert.equal(typeof onDrop, 'function', 'apply must register a capture-phase drop listener');

// An all-image drop stays with the image pipeline, untouched.
const imageDrop = event([fakeFile('shot.png', 'image/png', 'x')]);
onDrop(imageDrop);
assert.equal(imageDrop.stopped, false, 'image drops must pass through');
assert.equal(state.commits.length, 0);

// A drop carrying an accepted image alongside others is left alone: the
// attachment store must keep ownership of its own media type.
const mixedDrop = event([fakeFile('shot.png', 'image/png', 'x'), fakeFile('doc.pdf', 'application/pdf', 'x')]);
onDrop(mixedDrop);
assert.equal(mixedDrop.stopped, false, 'mixed drops are out of scope and must not be hijacked');

// A non-image drop is intercepted, uploaded, and referenced.
const pdfDrop = event([fakeFile('quarterly report.pdf', 'application/pdf', 'pdf bytes')]);
onDrop(pdfDrop);
assert.equal(pdfDrop.stopped, true, 'the attachment pipeline must not see the refusal');
assert.equal(pdfDrop.prevented, true, 'the browser must not navigate to the dropped file');
await settle(() => state.draft !== '');
assert.equal(state.draft, '@".dsh-drops/quarterly report.pdf" ', 'paths with spaces use the quoted grammar');
assert.equal(state.commits.length, 1);
assert.equal(state.commits[0][0], 'session-1', 'the session id is what the host resolves to an Agent');
assert.equal(state.commits[0][1], 'quarterly report.pdf');
assert.equal(state.commits[0][2], btoa('pdf bytes'), 'the payload is canonical base64 of the file bytes');

// ── appending and error reporting ──────────────────────────────────────────

state.draft = 'look at';
const second = event([fakeFile('notes.txt', 'text/plain', 'hi')]);
onDrop(second);
await settle(() => state.draft.includes('notes.txt'));
assert.equal(state.draft, 'look at @.dsh-drops/notes.txt ', 'a mention is separated from existing text');

const failing = fakeContext({ commit: async () => ({ ok: false, error: { message: 'disk full' } }) });
await clientModule.apply(failing.ctx);
failing.state.listeners.get('drop')(event([fakeFile('a.bin', 'application/octet-stream', 'x')]));
await settle(() => failing.state.notices.length > 0);
assert.deepEqual(failing.state.notices, [{ level: 'error', text: 'Drop reference failed: disk full' }]);
assert.equal(failing.state.draft, '', 'a refused upload must not edit the draft');

console.log('drop-reference browser half: ok');
