import type { ViewExportOptions } from '../../shared/viewer-protocol';

/** The current view as a PNG, base64-encoded, or why it could not be made. */
export type ViewCaptureResult =
	| { payload: string; width: number; height: number; scale: number }
	| { error: string };

interface ViewAnswer { requestId: number; payload?: string; width?: number; height?: number; scale?: number; error?: string }

/**
 * The request/response pair behind "export the current view" for any webview:
 * ask it for a capture, match the answer to the question by id, and give up
 * after a while so a viewer that never answers cannot hang a command.
 */
export class ViewCaptureChannel {
	private next = 0;
	private readonly pending = new Map<number, (result: ViewCaptureResult) => void>();

	constructor(
		private readonly post: (message: { type: 'exportView'; requestId: number; options: ViewExportOptions }) => void,
		private readonly timeoutMs = 60_000,
	) { }

	capture(options: ViewExportOptions): Promise<ViewCaptureResult> {
		return new Promise(resolve => {
			const requestId = ++this.next;
			const timer = setTimeout(() => this.settle(requestId, { error: 'The viewer did not answer in time.' }), this.timeoutMs);
			this.pending.set(requestId, result => { clearTimeout(timer); resolve(result); });
			this.post({ type: 'exportView', requestId, options });
		});
	}

	/** Feed the webview's `didExportView` message in. Answers nobody is waiting for are ignored. */
	receive(message: ViewAnswer): void {
		if (message.error || !message.payload) {
			this.settle(message.requestId, { error: message.error || 'The viewer returned no image.' });
		} else {
			this.settle(message.requestId, { payload: message.payload, width: message.width ?? 0, height: message.height ?? 0, scale: message.scale ?? 1 });
		}
	}

	dispose(): void {
		for (const id of [...this.pending.keys()]) { this.settle(id, { error: 'The viewer was closed.' }); }
	}

	private settle(requestId: number, result: ViewCaptureResult): void {
		const resolve = this.pending.get(requestId);
		if (!resolve) { return; }
		this.pending.delete(requestId);
		resolve(result);
	}
}

/** `<name>.view.png` for a source, `<name>.view@2x.png` at double resolution, and `image.view.png` when there is no name. */
export function viewFileName(source: string, scale = 1): string {
	const base = source.split(/[\\/]/).pop() || 'image';
	const dot = base.lastIndexOf('.');
	const stem = dot > 0 ? base.slice(0, dot) : base;
	return `${stem}.view${scale > 1 ? '@2x' : ''}.png`;
}
