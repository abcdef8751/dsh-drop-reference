/**
 * dsh-drop-reference — host half.
 *
 * A browser drag-and-drop hands a page the file's bytes but never the host path
 * it came from, so a dropped file that DSH's image-only attachment pipeline
 * refuses cannot become an `@` reference by itself: an `@` reference is prompt
 * text naming a path the model-facing `read` tool must later open, and no such
 * path exists until something writes the bytes to disk.
 *
 * This half is that something. The browser half posts each refused file here,
 * this half writes it beside the session's working directory, and the browser
 * half then inserts the returned `@` reference into the composer.
 *
 * Why the marker dance below: the Host Gateway dispatches Remote calls in two
 * modes. Strict mode reads descriptors generated at build time by the in-repo
 * Typert toolchain; SRC mode is the documented fallback for "endpoints that
 * have never had a strict definition" and derives its parameter list by
 * reflecting on the service method itself. An out-of-tree plugin has no
 * generated descriptor, so it can still be reached — but only if the gateway
 * can see a `@Remote` marker on the prototype. `Remote()` is a standard method
 * decorator, and decorators are TypeScript syntax that this plain-JavaScript
 * file cannot spell, so the decorator is invoked by hand against a synthetic
 * decorator context and the initializer it registers is run in the
 * constructor, which is exactly where the compiler would have run it.
 *
 * @module dsh-drop-reference
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

/** Cordis service key, and therefore the wire namespace: `dropFiles/commit`. */
const SERVICE_KEY = 'dropFiles';

/** Collected by the synthetic decorator context, replayed against each instance. */
const remoteInitializers = [];

/**
 * Mark `commit` as a Remote method at class-definition time.
 *
 * `Remote(name)` in its string form returns the decorator itself. Handing it a
 * context with the three fields `addMarkerInitializer` inspects (`name`,
 * `private`, `static`) plus an `addInitializer` sink produces the same private
 * prototype marker a real decorator would install.
 */
{
	const markCommit = Remote('commit');
	markCommit(undefined, {
		name: 'commit',
		private: false,
		static: false,
		addInitializer(initializer) {
			remoteInitializers.push(initializer);
		}
	});
}

/** Default drop directory, relative to the agent's working directory. */
const DEFAULT_DIRECTORY = '.dsh-drops';

/** Default per-file ceiling; the browser half refuses larger files before upload. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** Strip anything that could escape the drop directory or upset a shell. */
function safeName(raw) {
	const base = basename(String(raw ?? '')).replace(/[\u0000-\u001f\u007f]/gu, '');
	const cleaned = base.replace(/[\\/]/gu, '_').replace(/^\.+$/u, '').trim();
	if (cleaned === '') return 'dropped-file';
	return cleaned.length > 128 ? cleaned.slice(-128) : cleaned;
}

/** Resolve the configured directory against the agent's own working directory. */
function targetDirectory(configured, cwd) {
	const wanted = typeof configured === 'string' && configured !== '' ? configured : DEFAULT_DIRECTORY;
	return isAbsolute(wanted) ? resolve(wanted) : resolve(cwd, wanted);
}

/**
 * Collision-free path: `report.pdf`, then `report-1.pdf`, `report-2.pdf`, …
 * @param directory - resolved drop directory.
 * @param name - sanitized file name.
 * @returns a path that does not exist yet, best effort.
 */
async function uniquePath(directory, name) {
	const extension = extname(name);
	const stem = extension === '' ? name : name.slice(0, -extension.length);
	for (let index = 0; index < 1000; index += 1) {
		const candidate = join(directory, index === 0 ? name : `${stem}-${String(index)}${extension}`);
		try {
			await access(candidate);
		} catch {
			return candidate;
		}
	}
	return join(directory, `${stem}-${String(Date.now())}${extension}`);
}

/**
 * Host capability behind the browser drop handler.
 *
 * Config:
 * - `directory` — drop directory; absolute, or relative to the session working
 *   directory. Defaults to `.dsh-drops`.
 * - `maxBytes` — per-file ceiling. Defaults to 32 MiB.
 */
export class DropReferenceService extends TypertRemoteService {
	/**
	 * @param ctx - owning Cordis context.
	 * @param config - plugin config from the profile's Loader row.
	 */
	constructor(ctx, config = {}) {
		super(ctx, SERVICE_KEY);
		for (const initializer of remoteInitializers) initializer.call(this);
		this.config = {
			directory: config.directory,
			maxBytes:
				Number.isSafeInteger(config.maxBytes) && config.maxBytes > 0 ? config.maxBytes : DEFAULT_MAX_BYTES
		};
	}

	/**
	 * Write one dropped file into the session's drop directory.
	 *
	 * Parameter names are load-bearing: `agent` is a Typert lookup parameter in
	 * SRC mode, so the gateway resolves the incoming session id to the live Agent
	 * and this method receives the object rather than the id. Renaming it, or
	 * adding destructuring or default values, breaks SRC signature parsing.
	 *
	 * @param agent - resolved Agent for the session that owns the drop.
	 * @param name - client-supplied original file name.
	 * @param data - canonical base64 of the file bytes.
	 * @returns the absolute path plus the prompt-text spelling for it.
	 */
	async commit(agent, name, data) {
		const cwd = this.workingDirectoryOf(agent);
		const directory = targetDirectory(this.config.directory, cwd);
		const bytes = Buffer.from(String(data ?? ''), 'base64');
		if (bytes.byteLength === 0) throw new Error('dropFiles: empty payload');
		if (bytes.byteLength > this.config.maxBytes) {
			throw new Error(`dropFiles: file exceeds the ${String(this.config.maxBytes)}-byte limit`);
		}
		const fileName = safeName(name);
		await mkdir(directory, { recursive: true });
		const path = await uniquePath(directory, fileName);
		await writeFile(path, bytes, { flag: 'wx' });
		const relativePath = relative(cwd, path);
		const insideCwd = relativePath !== '' && !relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath);
		return {
			path,
			mention: insideCwd ? relativePath.split(sep).join('/') : path,
			bytes: bytes.byteLength
		};
	}

	/**
	 * The agent's working directory, with a fallback for a bare session id when
	 * the `agent` lookup is unavailable.
	 * @param agent - resolved Agent, or a raw session id.
	 * @returns an absolute directory path.
	 */
	workingDirectoryOf(agent) {
		let session = typeof agent === 'object' && agent !== null ? agent.session : undefined;
		if (session === undefined && typeof agent === 'string') session = this.ctx.get('agents')?.get(agent)?.session;
		return session?.header?.cwd ?? process.cwd();
	}
}

export default DropReferenceService;
