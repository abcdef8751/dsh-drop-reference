/**
 * dsh-drop-reference — browser half.
 *
 * DSH's composer drop target is image-only (`dsh-attachment-local` admits
 * image/png, image/jpeg, image/webp, image/gif and nothing else), and the
 * document-level handler in `dsh-client-ui-attachment` forwards *every* dropped
 * file into that pipeline — so dropping a PDF today ends in
 * `UNSUPPORTED_IMAGE_TYPE` rather than a usable reference.
 *
 * This bundle closes that gap for drops that carry no accepted image at all:
 * it takes the drop away from the attachment pipeline in the capture phase,
 * posts the bytes to the host half, and splices the returned `@<path>` into the
 * composer draft, which is what turns the file into something the model's
 * `read` tool can actually open.
 *
 * Two seams are undocumented-by-necessity and worth naming:
 *
 * 1. The client cannot call an arbitrary host service. `ctx.remote.$mount()`
 *    insists every descriptor carry a `codec.mode === "strict"` entry whose
 *    schema exposes `parse()` — it never checks that the schema came from the
 *    Typert generator, so an identity codec validates and mounts. The host then
 *    answers in SRC mode, because no strict definition for this endpoint was
 *    ever generated.
 * 2. The host half is reached through the `agent` lookup parameter, so the
 *    browser only has to know *which session* owns the drop; the host resolves
 *    the Agent and writes beside that session's own working directory.
 */

window.__ModuleLoader__.load({
	id: 'dsh-drop-reference',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		/** Must match the host service key; the endpoint is `dropFiles/commit`. */
		const NAMESPACE = 'dropFiles';

		/** Kept in lockstep with `dsh-attachment-local`'s hardcoded admission list. */
		const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

		/** Mirror of the host default; refused client-side for a friendlier message. */
		const MAX_BYTES = 32 * 1024 * 1024;

		/**
		 * The generator emits `typeSymbol` plus a real schema. The registry only
		 * checks that `typeSymbol` is nonempty and `schema.parse` is callable, so
		 * an identity codec round-trips the payload without a Typert build.
		 * @param {string} subject - schema key, unique per descriptor field.
		 * @returns a strict-shaped codec.
		 */
		const strictCodec = (subject) => ({
			mode: 'strict',
			typeSymbol: `dsh-drop-reference#${subject}`,
			schema: { parse: (value) => value }
		});

		/**
		 * Contribution mounted into `ctx.remote`. `agent` stays a lookup parameter
		 * so the host resolves the session id to a live Agent; the other two ride
		 * the wire as plain JSON fields.
		 */
		const CONTRIBUTION = {
			package: 'dsh-drop-reference',
			descriptors: [
				{
					id: 'dsh-drop-reference#dropFiles/commit',
					service: NAMESPACE,
					namespace: NAMESPACE,
					method: 'commit',
					invocation: { kind: 'direct' },
					parameters: [
						{
							name: 'agent',
							wire: 'agentId',
							source: 'lookup',
							lookup: 'agent',
							codec: strictCodec('dropFiles/commit:agent')
						},
						{
							name: 'name',
							wire: 'name',
							source: 'json',
							codec: strictCodec('dropFiles/commit:name')
						},
						{
							name: 'data',
							wire: 'data',
							source: 'json',
							codec: strictCodec('dropFiles/commit:data')
						}
					],
					result: strictCodec('dropFiles/commit:result')
				}
			]
		};

		/**
		 * Whether one dropped file belongs to the image attachment pipeline.
		 * @param {File} file - dropped file.
		 * @returns true for a media type `dsh-attachment-local` admits.
		 */
		const isAcceptedImage = (file) => ACCEPTED_IMAGE_TYPES.includes(file.type);

		/**
		 * Spell a path the way the composer's `@` grammar expects.
		 * @param {string} path - host path or workspace-relative path.
		 * @returns the mention text, or undefined for a path the grammar cannot carry.
		 */
		const formatMention = (path) => {
			if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;
			return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
		};

		/**
		 * Append mentions to a draft without gluing them to existing text.
		 * @param {string} draft - current draft.
		 * @param {string[]} mentions - mention spellings.
		 * @returns the next draft.
		 */
		const appendMentions = (draft, mentions) => {
			let next = draft;
			for (const mention of mentions) {
				if (next !== '' && !/\s$/u.test(next)) next += ' ';
				next += `${mention} `;
			}
			return next;
		};

		/**
		 * Base64-encode a file in chunks; `String.fromCharCode.apply` on a whole
		 * multi-megabyte array overflows the argument stack.
		 * @param {File} file - dropped file.
		 * @returns canonical base64.
		 */
		const encode = async (file) => {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const chunk = 0x8000;
			let binary = '';
			for (let offset = 0; offset < bytes.length; offset += chunk) {
				binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk));
			}
			return btoa(binary);
		};

		/**
		 * Clear the attachment plugin's drag state after a drop it never sees.
		 *
		 * That plugin tracks a document-level enter/leave depth and clears its
		 * full-page overlay from `drop` or `dragend`. An OS file drop fires no
		 * `dragend` inside the page, so taking the `drop` event away would strand
		 * the overlay on screen. Replaying a synthetic `dragleave` — carrying a
		 * file so the plugin's `types.includes("Files")` guard passes — drives its
		 * depth back to zero. Extra dispatches are harmless: the depth floors.
		 */
		const clearDropOverlay = () => {
			try {
				const transfer = new DataTransfer();
				transfer.items.add(new File([new Blob([''])], 'dsh-drop-reference'));
				for (let attempt = 0; attempt < 8; attempt += 1) {
					document.dispatchEvent(
						new DragEvent('dragleave', {
							bubbles: true,
							cancelable: false,
							clientX: 0,
							clientY: 0,
							dataTransfer: transfer
						})
					);
				}
			} catch (error) {
				console.warn('drop-reference: could not clear the drop overlay', error);
			}
		};

		/**
		 * The session whose composer is on screen.
		 * @param {object} ctx - client Cordis context.
		 * @returns the session id, or undefined when nothing is selected.
		 */
		const currentSessionId = (ctx) => {
			try {
				return ctx.get('sessions')?.list?.getSnapshot()?.current;
			} catch {
				return undefined;
			}
		};

		/**
		 * The composer shell for a session, through the conversation service.
		 * @param {object} ctx - client Cordis context.
		 * @param {string} sessionId - target session.
		 * @returns the input shell, or undefined when the session has no composer.
		 */
		const shellOf = (ctx, sessionId) => {
			try {
				return ctx.get('conversation')?.input?.shell(sessionId);
			} catch {
				return undefined;
			}
		};

		/**
		 * Write every dropped file to the host and reference them in the draft.
		 * @param {object} ctx - client Cordis context.
		 * @param {File[]} files - dropped, non-image files.
		 */
		const handleDrop = async (ctx, files) => {
			const sessionId = currentSessionId(ctx);
			const shell = sessionId === undefined ? undefined : shellOf(ctx, sessionId);
			if (shell === undefined) {
				console.warn('drop-reference: no active session to reference the dropped files from');
				return;
			}
			const remote = ctx.get(`remote.${NAMESPACE}`) ?? ctx.get('remote')?.[NAMESPACE];
			if (remote === undefined) {
				shell.notify('error', 'Drop reference is unavailable: its host service is not mounted.');
				return;
			}
			const oversized = files.filter((file) => file.size > MAX_BYTES);
			if (oversized.length > 0) {
				shell.notify('error', `Dropped file is larger than ${String(Math.round(MAX_BYTES / (1024 * 1024)))} MB.`);
				return;
			}
			const mentions = [];
			for (const file of files) {
				try {
					const outcome = await remote.commit(sessionId, file.name, await encode(file));
					if (!outcome?.ok) {
						shell.notify('error', `Drop reference failed: ${outcome?.error?.message ?? 'unknown error'}`);
						continue;
					}
					const mention = formatMention(outcome.value?.mention ?? outcome.value?.path);
					if (mention === undefined) {
						shell.notify('error', `Cannot reference ${file.name}: its path needs characters the @ grammar cannot carry.`);
						continue;
					}
					mentions.push(mention);
				} catch (error) {
					shell.notify('error', `Drop reference failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (mentions.length === 0) return;
			shell.setDraft(appendMentions(shell.snapshot.draft ?? '', mentions));
		};

		/** Client services this plugin needs before it can act. */
		const inject = ['remote', 'sessions', 'conversation'];

		/**
		 * Mount the Remote contribution and own the capture-phase drop listener.
		 *
		 * Capture on `window` is deliberate: `dsh-client-ui-attachment` listens on
		 * `document` in the bubble phase, so a window-capture listener runs first
		 * and `stopPropagation` keeps the refusal out of the image pipeline.
		 *
		 * @param {object} ctx - client Cordis context.
		 */
		async function apply(ctx) {
			const disposeRemote = await ctx.remote.$mount(CONTRIBUTION);
			ctx.effect(() => {
				const onDrop = (event) => {
					const transfer = event.dataTransfer;
					if (!transfer || !transfer.types.includes('Files')) return;
					const files = [...transfer.files];
					// Any accepted image means the drop belongs to the attachment
					// pipeline, which owns that media type end to end. A mixed drop is
					// therefore left alone rather than half-handled here.
					if (files.length === 0 || files.some(isAcceptedImage)) return;
					event.preventDefault();
					event.stopPropagation();
					clearDropOverlay();
					void handleDrop(ctx, files);
				};
				window.addEventListener('drop', onDrop, true);
				return () => {
					window.removeEventListener('drop', onDrop, true);
					void disposeRemote();
				};
			}, 'drop-reference: capture-phase drop target');
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
