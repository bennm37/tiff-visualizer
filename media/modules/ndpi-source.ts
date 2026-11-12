/**
 * Ranged access to a Hamamatsu NDPI slide. A slide is hundreds of megabytes
 * to several gigabytes; opening reads its directory (a few kilobytes per
 * image) and each view then reads only the JPEG restart intervals it covers.
 * The VS Code webview and the standalone viewer's blob: URLs both answer HTTP
 * Range requests with 206; a source that does not is reported as unavailable
 * and the caller reads the file whole.
 *
 * Parsing, planning and decoding are Rust (`formats/ndpi.rs`) in the decode
 * worker; this module only moves bytes. The worker is handed the pieces read
 * so far with every request and answers `[need-range:OFFSET:LENGTH]` when it
 * needs another, the protocol `ranged-source.ts` uses. Directory pieces are
 * kept for the life of the source (the "index"); pixel data is read per
 * region from the byte plan the worker returns and is not kept.
 */
import type { DecodeWorkerLike } from './decode-worker-client.js';
import { readRange } from './ranged-source.js';

const HEAD_BYTES = 4096;
const NEED_RANGE = /\[need-range:(\d+):(\d+)\]/;
/** A slide with many focal planes has many directories; each costs a read or two. */
const MAX_ROUND_TRIPS = 1024;
/** The index holds directories and restart-interval tables, never pixel data. */
const MAX_INDEX_BYTES = 256 * 1024 * 1024;
const PARALLEL_READS = 6;

interface Piece { offset: number, bytes: Uint8Array }

export interface NdpiLevel {
	/** Linear reduction against the full-resolution level. */
	factor: number;
	width: number;
	height: number;
	/** Whether a rectangle of this level decodes without reading all of it. */
	randomAccess: boolean;
	/** Size of one restart interval, the smallest unit a region read costs. */
	intervalWidth: number;
	intervalHeight: number;
}

export interface NdpiLayout {
	width: number;
	height: number;
	channels: number;
	bitsPerSample: number;
	sampleFormat: 1 | 2 | 3;
	typeMin: number;
	typeMax: number;
	sourceNumericType: string;
	/** Stored pyramid levels of the selected image, full resolution first. */
	levels: NdpiLevel[];
	metadataJson: string;
}

export interface NdpiRegionRequest {
	/** `S` 1 selects the macro image, `Z` a focal plane. */
	indices: Record<string, number>;
	/** Index into the layout's `levels`. */
	level: number;
	/** Rectangle in pixels of that level; the whole level when absent. */
	rect?: { x: number, y: number, width: number, height: number };
}

export class NdpiSource {
	readonly src: string;
	readonly size: number;
	private readonly _worker: DecodeWorkerLike;
	private readonly _index: Piece[];
	private _indexBytes: number;
	private readonly _layouts = new Map<string, NdpiLayout>();
	/** Ranges read by this source, for the load's `[Perf]` line. */
	bytesRead: number;

	private constructor(src: string, size: number, head: Uint8Array, worker: DecodeWorkerLike) {
		this.src = src;
		this.size = size;
		this._worker = worker;
		this._index = [{ offset: 0, bytes: head }];
		this._indexBytes = head.length;
		this.bytesRead = head.length;
	}

	/**
	 * Open `src` for ranged reads, or null when its host answers no ranges, it
	 * is not TIFF-structured, or there is no decode worker.
	 */
	static async open(src: string, worker: DecodeWorkerLike | null | undefined, signal?: AbortSignal): Promise<NdpiSource | null> {
		try {
			const booting = worker?.whenBooting?.();
			if (booting) { await booting; }
			if (!worker?.canDecode('ndpi-layout')) { return null; }
			const { bytes: head, total } = await readRange(src, 0, HEAD_BYTES, signal);
			if (!(total > 0) || head.length < 12) { return null; }
			// "II*\0": NDPI is always little-endian classic TIFF at the top.
			if (head[0] !== 0x49 || head[1] !== 0x49 || head[2] !== 0x2a || head[3] !== 0) { return null; }
			return new NdpiSource(src, total, head, worker);
		} catch (error) {
			if (signal?.aborted) { throw error; }
			return null;
		}
	}

	/**
	 * Run `format` in the worker over the index plus `data`, reading into the
	 * index whatever the decoder still asks for.
	 */
	private async _request(format: string, options: Record<string, any>, data: Piece[], signal?: AbortSignal): Promise<any> {
		for (let trip = 0; trip <= MAX_ROUND_TRIPS; trip++) {
			const pieces = [...this._index, ...data];
			const blob = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.bytes.length, 0));
			let at = 0;
			for (const piece of pieces) {
				blob.set(piece.bytes, at);
				at += piece.bytes.length;
			}
			const response = await this._worker.decode(format, blob.buffer, {
				...options,
				rangedOffsets: pieces.map(piece => piece.offset),
				rangedLengths: pieces.map(piece => piece.bytes.length),
				fileSize: this.size,
			});
			if (signal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
			if (!response) { throw new Error('Decode worker unavailable'); }
			if (response.ok) { return response.result; }
			const need = NEED_RANGE.exec(String(response.error || ''));
			if (!need) { throw new Error(String(response.error || `NDPI ${format} failed`)); }
			const offset = Number(need[1]);
			const length = Number(need[2]);
			if (!(length > 0) || this._indexBytes + length > MAX_INDEX_BYTES) {
				throw new Error(`NDPI ${format} asked for ${length} bytes of index`);
			}
			const { bytes } = await readRange(this.src, offset, length, signal);
			this.bytesRead += bytes.length;
			this._indexBytes += bytes.length;
			this._index.push({ offset, bytes });
		}
		throw new Error(`NDPI ${format} needed more than ${MAX_ROUND_TRIPS} reads`);
	}

	async layout(indices: Record<string, number>, signal?: AbortSignal): Promise<NdpiLayout> {
		const key = JSON.stringify(indices || {});
		const cached = this._layouts.get(key);
		if (cached) { return cached; }
		const layout = await this._request('ndpi-layout', { indices }, [], signal) as NdpiLayout;
		this._layouts.set(key, layout);
		return layout;
	}

	/**
	 * Decode one region: plan it in the worker, read the planned ranges,
	 * decode. Resolves to the worker's decoded-array result (Float32 samples,
	 * numeric domain, statistics, the image's metadata).
	 */
	async region(request: NdpiRegionRequest, signal?: AbortSignal): Promise<any> {
		const options = {
			indices: request.indices,
			level: request.level,
			...(request.rect ? { rect: request.rect } : {}),
		};
		const plan = await this._request('ndpi-plan', options, [], signal);
		const ranges = plan.ranges as [number, number][];
		const data: Piece[] = new Array(ranges.length);
		let next = 0;
		const readNext = async (): Promise<void> => {
			while (next < ranges.length) {
				const index = next++;
				const [offset, length] = ranges[index];
				data[index] = { offset, bytes: (await readRange(this.src, offset, length, signal)).bytes };
			}
		};
		await Promise.all(Array.from({ length: Math.min(PARALLEL_READS, ranges.length) }, readNext));
		if (signal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
		this.bytesRead += data.reduce((sum, piece) => sum + piece.bytes.length, 0);
		return this._request('ndpi-region', options, data, signal);
	}
}
