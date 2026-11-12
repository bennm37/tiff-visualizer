/**
 * Zeiss CZI through ranged reads (`czi-source.ts`). A plane of an ordinary
 * file decodes from only its own subblocks; a mosaic too large to hold whole
 * opens at a stored pyramid level that fits the window and serves finer
 * levels region by region through the same `PyramidScene` large TIFFs use.
 * Without range support or a decode worker it reads the file whole, as before.
 * The scene itself is `ranged-scene-processor.ts`, shared with NDPI.
 */
import { RangedSceneProcessor, type SceneRect, type SceneRegion } from './ranged-scene-processor.js';
import { CziSource, type CziLayout } from './czi-source.js';
import { PerfTrace } from './perf-trace.js';

/** Planes above this many pixels open as a pyramid scene. */
const SCENE_MIN_PIXELS = 50_000_000;
/** The overview: the finest level whose plane stays within this many pixels. */
const OVERVIEW_MAX_PIXELS = 8_000_000;

export class CziProcessor extends RangedSceneProcessor {
	private _source: CziSource | null = null;
	private _sourceTried = '';
	private _indices: Record<string, number> = {};
	private _layout: CziLayout | null = null;

	async load(src: string, decodeOptions: Record<string, any> = {}) {
		const signal = this.loadSignal;
		if (this._sourceTried !== src) {
			this._sourceTried = src;
			this._source = await CziSource.open(src, this.decodeWorker, signal);
		}
		const source = this._source;
		if (signal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
		if (!source) {
			this._clearScene();
			return super.load(src, decodeOptions);
		}
		try {
			return await this._loadCziRanged(source, decodeOptions);
		} catch (error) {
			if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) { throw error; }
			console.warn('[CZI] ranged read failed, reading the file whole:', error);
			this._source = null;
			this._clearScene();
			return super.load(src, decodeOptions);
		}
	}

	private async _loadCziRanged(source: CziSource, decodeOptions: Record<string, any>) {
		const signal = this.loadSignal;
		const indices: Record<string, number> = { ...(decodeOptions.indices || {}) };
		const started = performance.now();
		const layout = await source.layout(indices);
		const metadata = JSON.parse(layout.metadataJson || '{}');
		const factors = layout.factors?.length ? layout.factors : [1];
		const full = layout.width * layout.height;
		const sceneFactors = full > SCENE_MIN_PIXELS ? sceneLevels(layout.width, layout.height, factors) : [1];
		const overview = sceneFactors.find(factor => (layout.width / factor) * (layout.height / factor) <= OVERVIEW_MAX_PIXELS)
			?? sceneFactors[sceneFactors.length - 1];
		const decoded = await source.region({ indices, factor: overview }, signal);
		if (signal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
		PerfTrace.detail('czi-ranged-read+decode', performance.now() - started);
		PerfTrace.note('czi-ranged-bytes', `${(source.bytesRead / 1048576).toFixed(1)}MB of ${(source.size / 1048576).toFixed(0)}MB`);

		this._clearScene();
		this._indices = indices;
		this._layout = layout;
		this._workerCachedSource = '';
		if (sceneFactors.length > 1) {
			this.pageDirectory = sceneFactors.map((factor, index) => ({
				index,
				width: Math.ceil(layout.width / factor),
				height: Math.ceil(layout.height / factor),
				samplesPerPixel: layout.channels,
				subfileType: index === 0 ? 0 : 1,
				kind: index === 0 ? 'image' : 'overview',
				parent: index === 0 ? null : 0,
				reduction: factor,
				subIfdCount: 0,
				blockWidth: 512,
				blockHeight: 512,
			}));
			this.pageIndex = sceneFactors.indexOf(overview);
			metadata.pyramidLevels = sceneFactors.length;
			metadata.displayedLevelReduction = overview;
		}
		decoded.metadata = { ...metadata, ...(decoded.metadata || {}) };
		const result = this._adoptDecoded(decoded, { width: layout.width, height: layout.height });
		if (this.isScene) {
			this._lastStatistics = this._decodedStats ? { ...this._decodedStats } : null;
			this._cacheRegion(this.pageIndex, 0, 0, decoded.width, decoded.height, decoded.channels, decoded.data);
		}
		return result;
	}

	protected async _readLevelRegion(levelIndex: number, rect: SceneRect, signal?: AbortSignal): Promise<SceneRegion | null> {
		const level = this.pageDirectory[levelIndex];
		if (!this._source || !level) { return null; }
		const factor = Math.max(1, level.reduction);
		return this._source.region({
			indices: this._indices,
			factor,
			rect: { x: rect.x * factor, y: rect.y * factor, width: rect.width * factor, height: rect.height * factor },
			parallel: true,
		}, signal);
	}
}

/**
 * Scene levels for a plane: the stored pyramid factors, extended by halvings
 * read from the finest available level when the file stores none small enough
 * for an overview (a large mosaic without a pyramid still opens).
 */
function sceneLevels(width: number, height: number, stored: number[]): number[] {
	const factors = [...new Set([1, ...stored])].sort((a, b) => a - b);
	let coarsest = factors[factors.length - 1];
	while ((width / coarsest) * (height / coarsest) > OVERVIEW_MAX_PIXELS) {
		coarsest *= 2;
		factors.push(coarsest);
	}
	return factors;
}
