/**
 * Hamamatsu NDPI whole-slide images through ranged reads (`ndpi-source.ts`).
 * A slide is far too large to decode whole, so it opens at the stored pyramid
 * level that fits an overview and serves finer levels region by region
 * through the pyramid scene (`ranged-scene-processor.ts`), as CZI mosaics and
 * large TIFF pyramids do. The macro photograph and small slides decode whole.
 * Without range support or a decode worker the file is read whole and shown
 * at the finest level that fits in memory.
 */
import { RangedSceneProcessor, type SceneRect, type SceneRegion } from './ranged-scene-processor.js';
import { NdpiSource, type NdpiLayout, type NdpiLevel } from './ndpi-source.js';
import { PerfTrace } from './perf-trace.js';

/**
 * Images above this many pixels open as a pyramid scene. Lower than for CZI:
 * a slide is RGB, and samples are carried as three floats per pixel.
 */
const SCENE_MIN_PIXELS = 16_000_000;
/** The overview: the finest level that stays within this many pixels. */
const OVERVIEW_MAX_PIXELS = 8_000_000;
/** Edge of a scene tile; a level's tiles are whole restart intervals near it. */
const TILE_SIZE = 512;
/**
 * Restart intervals up to this wide become whole tiles. A NanoZoomer writes
 * 2048x8 intervals at full resolution: a 512-pixel tile would read and decode
 * each interval four times over, once per tile it spans.
 */
const MAX_ALIGNED_INTERVAL = 4096;

const pixels = (level: NdpiLevel) => level.width * level.height;

/**
 * Tile size for a level. A region read costs whole restart intervals, so a
 * tile is a whole number of them where they are small enough to allow it.
 */
function tileSize(level: NdpiLevel): { width: number, height: number } {
	const fit = (interval: number) => interval > 0 && interval <= MAX_ALIGNED_INTERVAL
		? Math.max(1, Math.round(TILE_SIZE / interval)) * interval
		: TILE_SIZE;
	return level.randomAccess
		? { width: fit(level.intervalWidth), height: fit(level.intervalHeight) }
		: { width: TILE_SIZE, height: TILE_SIZE };
}

export class NdpiProcessor extends RangedSceneProcessor {
	private _source: NdpiSource | null = null;
	private _sourceTried = '';
	private _indices: Record<string, number> = {};
	/** For each scene level, its index among the file's stored levels. */
	private _storedLevels: number[] = [];
	private _overview: (SceneRegion & { level: number }) | null = null;

	protected _clearScene(): void {
		super._clearScene();
		this._storedLevels = [];
		this._overview = null;
	}

	async load(src: string, decodeOptions: Record<string, any> = {}) {
		const signal = this.loadSignal;
		if (this._sourceTried !== src) {
			this._sourceTried = src;
			this._source = await NdpiSource.open(src, this.decodeWorker, signal);
		}
		const source = this._source;
		if (signal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
		if (!source) {
			this._clearScene();
			return super.load(src, { ...decodeOptions, maxPixels: SCENE_MIN_PIXELS });
		}
		try {
			return await this._loadNdpiRanged(source, decodeOptions);
		} catch (error) {
			if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) { throw error; }
			console.warn('[NDPI] ranged read failed, reading the file whole:', error);
			this._source = null;
			this._clearScene();
			return super.load(src, { ...decodeOptions, maxPixels: SCENE_MIN_PIXELS });
		}
	}

	private async _loadNdpiRanged(source: NdpiSource, decodeOptions: Record<string, any>) {
		const signal = this.loadSignal;
		const indices: Record<string, number> = { ...(decodeOptions.indices || {}) };
		const started = performance.now();
		const readBefore = source.bytesRead;
		const layout = await source.layout(indices, signal);
		const plan = openingPlan(layout);
		const decoded = await source.region({ indices, level: plan.shown }, signal);
		if (signal?.aborted) { throw new DOMException('Load superseded', 'AbortError'); }
		PerfTrace.detail('ndpi-ranged-read+decode', performance.now() - started);
		PerfTrace.note('ndpi-ranged-bytes', `${((source.bytesRead - readBefore) / 1048576).toFixed(1)}MB of ${(source.size / 1048576).toFixed(0)}MB`);

		this._clearScene();
		this._indices = indices;
		this._workerCachedSource = '';
		if (plan.scene.length > 1) {
			this._storedLevels = plan.scene;
			this.pageDirectory = plan.scene.map((stored, index) => {
				const level = layout.levels[stored];
				const tile = tileSize(level);
				return {
					index,
					width: level.width,
					height: level.height,
					samplesPerPixel: layout.channels,
					subfileType: index === 0 ? 0 : 1,
					kind: index === 0 ? 'image' : 'overview',
					parent: index === 0 ? null : 0,
					reduction: level.factor,
					subIfdCount: 0,
					blockWidth: tile.width,
					blockHeight: tile.height,
				};
			});
			this.pageIndex = plan.scene.indexOf(plan.shown);
			// The scene is addressed in full-resolution pixels, so it keeps the
			// full-resolution physical pixel size rather than the overview's.
			decoded.metadata = {
				...(decoded.metadata || {}),
				...JSON.parse(layout.metadataJson || '{}'),
				displayedLevelReduction: layout.levels[plan.shown].factor,
			};
		}
		// A scene reports the slide's size; an image shown on its own, its own.
		const result = this._adoptDecoded(decoded, plan.scene.length > 1 ? { width: layout.width, height: layout.height } : undefined);
		if (this.isScene) {
			this._lastStatistics = this._decodedStats ? { ...this._decodedStats } : null;
			this._overview = { level: this.pageIndex, width: decoded.width, height: decoded.height, channels: decoded.channels, data: decoded.data };
			this._cacheRegion(this.pageIndex, 0, 0, decoded.width, decoded.height, decoded.channels, decoded.data);
		}
		return result;
	}

	protected async _readLevelRegion(levelIndex: number, rect: SceneRect, signal?: AbortSignal): Promise<SceneRegion | null> {
		const stored = this._storedLevels[levelIndex];
		if (!this._source || stored === undefined) { return null; }
		const overview = this._overview;
		if (overview && overview.level === levelIndex) {
			// Already decoded whole; a level without restart intervals could
			// only be read whole again.
			return cropRegion(overview, rect);
		}
		return this._source.region({ indices: this._indices, level: stored, rect }, signal);
	}
}

/**
 * Which stored level to show first and which levels form the scene.
 *
 * A small image is shown whole. A large one becomes a scene of its full
 * resolution level, the overview, and every level between them that can be
 * read in parts. When the full-resolution level cannot be read in parts there
 * is nothing to zoom into, and the finest level that fits is shown on its own.
 */
function openingPlan(layout: NdpiLayout): { shown: number, scene: number[] } {
	const levels = layout.levels;
	const within = (budget: number) => {
		const index = levels.findIndex(level => pixels(level) <= budget);
		return index < 0 ? levels.length - 1 : index;
	};
	if (pixels(levels[0]) <= SCENE_MIN_PIXELS) { return { shown: 0, scene: [0] }; }
	if (!levels[0].randomAccess) { return { shown: within(SCENE_MIN_PIXELS), scene: [] }; }
	const overview = within(OVERVIEW_MAX_PIXELS);
	const scene = levels
		.map((_, index) => index)
		.filter(index => index <= overview && (index === overview || levels[index].randomAccess));
	return { shown: overview, scene };
}

function cropRegion(source: SceneRegion, rect: SceneRect): SceneRegion | null {
	const x = Math.max(0, Math.floor(rect.x));
	const y = Math.max(0, Math.floor(rect.y));
	const width = Math.min(Math.floor(rect.width), source.width - x);
	const height = Math.min(Math.floor(rect.height), source.height - y);
	if (!(width > 0 && height > 0)) { return null; }
	const data = new Float32Array(width * height * source.channels);
	const run = width * source.channels;
	for (let row = 0; row < height; row++) {
		const from = ((y + row) * source.width + x) * source.channels;
		data.set(source.data.subarray(from, from + run), row * run);
	}
	return { width, height, channels: source.channels, data };
}
