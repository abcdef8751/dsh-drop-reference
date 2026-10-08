/**
 * Host dispatch test. Run with: node test/gateway.mjs
 *
 * `test/smoke.mjs` proves the marker exists; this proves the thing that
 * actually matters at runtime — that the real Host Gateway can *find* the
 * service through its SRC fallback, bind the arguments the browser sends, and
 * write the file.
 *
 * The gateway, the registry, and the wire-shaped entry point are the shipped
 * ones. Only the `agent` lookup is stubbed, because the real provider lives
 * behind the whole agent/session stack; the stub reproduces the exact
 * declaration (`parameter: "agent"`, `wire: "agentId"`) that `dsh-agent`
 * registers, which is the part this plugin's signature depends on.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import DropReferenceService from '../lib/index.js';

const cwd = await mkdtemp(join(tmpdir(), 'drop-reference-gateway-'));
const ctx = new Context();
await ctx.plugin(TypertRegistry);

/** Stand-in for the live agent the browser's session id resolves to. */
const agents = new Map([['session-1', { session: { header: { cwd } } }]]);
ctx.typert.lookups.register('agent', {
	parameter: 'agent',
	wire: 'agentId',
	hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent',
	wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
	resolve: (sessionId) => agents.get(sessionId)
});

await ctx.plugin(DropReferenceService, {});
await ctx.plugin(TypertGatewayService);
const gateway = ctx.get('typertGateway');
assert.ok(gateway, 'the gateway must mount');

// ── SRC discovery ──────────────────────────────────────────────────────────

// No generated descriptor exists for this endpoint, so claiming it is what
// routes the browser's POST here instead of to the legacy API proxy.
assert.equal(gateway.claimsEndpoint('dropFiles/commit'), true, 'the gateway must claim the endpoint');

const descriptor = gateway.resolveDescriptor('dropFiles', 'commit', 'dropFiles/commit');
assert.equal(descriptor.service, 'dropFiles');
assert.equal(descriptor.namespace, 'dropFiles');
assert.equal(descriptor.implementation, undefined, 'SRC dispatches the marked method directly');
assert.deepEqual(
	descriptor.parameters.map((parameter) => [parameter.name, parameter.wire, parameter.source]),
	[
		['agent', 'agentId', 'lookup'],
		['name', 'name', 'json'],
		['data', 'data', 'json']
	],
	'`agent` must stay a lookup parameter or the host would expect a session id, not an Agent'
);
for (const parameter of descriptor.parameters) {
	assert.equal(parameter.codec.mode, 'src-json', 'SRC descriptors carry the weaker JSON codec');
}

// ── the wire round-trip the browser performs ───────────────────────────────

const payload = Buffer.from('quarterly numbers', 'utf8').toString('base64');
const result = await gateway.invokeRpc('dropFiles/commit', {
	args: { agentId: 'session-1', name: 'quarterly report.pdf', data: payload }
});
assert.equal(result.ok, true, `dispatch failed: ${JSON.stringify(result.error)}`);
assert.equal(result.value.mention, '.dsh-drops/quarterly report.pdf');
assert.equal(await readFile(result.value.path, 'utf8'), 'quarterly numbers');
assert.equal(result.value.bytes, 17);

// A session id that resolves to no Agent is a policy failure, not a crash.
// The carrier collapses dispatch failures to the `internal` code with empty
// details, so the message is the only part worth asserting on — and it is what
// the browser half surfaces in its composer notice.
const unknown = await gateway.invokeRpc('dropFiles/commit', {
	args: { agentId: 'session-missing', name: 'x.pdf', data: payload }
});
assert.equal(unknown.ok, false);
assert.equal(unknown.error.code, 'internal');
assert.match(unknown.error.message, /did not resolve the requested identity/u);

// Malformed arguments are rejected at the boundary, before the method runs.
const extra = await gateway.invokeRpc('dropFiles/commit', {
	args: { agentId: 'session-1', name: 'x.pdf', data: payload, cwd: '/etc' }
});
assert.equal(extra.ok, false, 'unknown wire fields must not be smuggled through');

await rm(cwd, { recursive: true, force: true });
console.log('drop-reference host dispatch: ok');
