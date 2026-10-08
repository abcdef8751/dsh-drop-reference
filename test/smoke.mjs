/**
 * Host-half smoke test. Run with: node test/smoke.mjs
 *
 * Exercises the three things that are easy to get wrong and impossible to see
 * from the browser: that the hand-rolled `@Remote` marker lands on the
 * prototype, that the SRC signature parser still reads the parameter names, and
 * that `commit` writes the decoded bytes and reports a usable path.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import DropReferenceService from '../lib/index.js';

const ctx = new Context();
const service = new DropReferenceService(ctx, {});

// 1. The manual decorator replay must produce the marker the gateway looks for.
const markers = remoteMethods(service);
assert.deepEqual(
	markers.map((marker) => [marker.method, marker.invocation.kind]),
	[['commit', 'direct']],
	'commit must carry a direct Remote marker'
);

// 1b. SRC discovery walks `ctx.reflect.props` looking for a service whose
//     `typertRemote` binding names the requested namespace, so both halves of
//     the lookup must exist on the instance.
assert.equal(service.typertRemote.serviceKey, 'dropFiles');
assert.equal(service.typertRemote.namespace, 'dropFiles', 'the wire namespace must be dropFiles');

// 2. SRC mode parses identifiers out of the method source; destructuring,
//    defaults, or rest parameters would make the host reject the endpoint.
const source = DropReferenceService.prototype.commit.toString();
const names = source.slice(source.indexOf('(') + 1, source.indexOf(')')).split(',').map((part) => part.trim());
assert.deepEqual(names, ['agent', 'name', 'data'], 'commit must expose plain named parameters');

// 3. The write itself: bytes round-trip, the path is mentioned relative to cwd,
//    and a second drop of the same name does not clobber the first.
const cwd = await mkdtemp(join(tmpdir(), 'drop-reference-'));
const agent = { session: { header: { cwd } } };
const payload = Buffer.from('hello drop reference', 'utf8');
const first = await service.commit(agent, 'note.pdf', payload.toString('base64'));
assert.equal(await readFile(first.path, 'utf8'), 'hello drop reference');
assert.equal(first.mention, '.dsh-drops/note.pdf');
const second = await service.commit(agent, 'note.pdf', payload.toString('base64'));
assert.equal(second.mention, '.dsh-drops/note-1.pdf');
assert.notEqual(first.path, second.path);

// 4. Path traversal and control characters cannot escape the drop directory.
const hostile = await service.commit(agent, '../../etc/passwd', payload.toString('base64'));
assert.ok(hostile.path.startsWith(join(cwd, '.dsh-drops')), 'write must stay inside the drop directory');
assert.equal(hostile.mention, '.dsh-drops/passwd');

// 5. An absolute `directory` config wins over the session cwd, the mention falls
//    back to an absolute path, and an empty payload is refused.
const elsewhere = await mkdtemp(join(tmpdir(), 'drop-reference-abs-'));
const configured = new DropReferenceService(new Context(), { directory: elsewhere });
const outside = await configured.commit(agent, 'far.txt', payload.toString('base64'));
assert.ok(outside.path.startsWith(elsewhere), 'absolute config directory must be honored');
assert.equal(outside.mention, outside.path, 'a path outside cwd is mentioned absolutely');
await assert.rejects(() => service.commit(agent, 'empty.txt', ''), /empty payload/u);

await rm(cwd, { recursive: true, force: true });
await rm(elsewhere, { recursive: true, force: true });
console.log('drop-reference host half: ok');
