/**
 * The pyramid-scene half of a format read in ranges: an image too large to
 * hold whole is shown as one stored level, and finer levels are decoded
 * region by region into the `PyramidScene` large TIFFs use. CZI mosaics
 * (`czi-processor.ts`) and NDPI slides (`ndpi-processor.ts`) share it; each
 * supplies only how a region of a level is read.
 *
 * The scene contract (shared with TiffProcessor): `pageDirectory` lists the
 * levels (index 0 the full plane, overviews by reduction), `pageIndex` is the
 * level shown as the base canvas, `renderRegion` renders a rectangle of a
 * level with the image-wide statistics, and the readout methods answer from
 * decoded samples only.
 */
import { ScientificArrayProcessor } from './scientific-array-processor.js';
import { ImageRenderer, NormalizationHelper } from './normalization-helper.js';
import type { TiffPageEntry } from './tiff-pages.js';

const REGION_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const READOUT_BLOCK = 256;

export type SceneRect = { x: number, y: number, width: number, height: number };
export interface SceneRegion { width: number, height: number, channels: number, data: Float32Array }
interface CachedRegion extends SceneRegion { level: number, x: number, y: number, bytes: number }

export abstract class RangedSceneProcessor extends ScientificArrayProcessor {
	private _regionCache = new Map<string, CachedRegion>();
	private _regionCacheBytes = 0;
	protected _sceneGeneration = 0;

	/** Levels of the plane shown as a scene; empty when the plane is decoded whole. */
	pageDirectory: TiffPageEntry[] = [];
	pageIndex = 0;
	readonly isRemoteSource = false;
	readonly isProgressiveRemoteBase = false;
	readonly hasGeneratedPreview = false;
	_lastStatistics: { min: number, max: number } | null = null;

	get isScene(): boolean { return this.pageDirectory.length > 1; }

	/** Samples of `rect` (in pixels of the level) of scene level `levelIndex`. */
	protected abstract _readLevelRegion(levelIndex: number, rect: SceneRect, signal?: AbortSignal): Promise<SceneRegion | null>;

	resetForNewFile(): void {
		super.resetForNewFile();
		this._clearScene();
	}

	protected _clearScene(): void {
		this.pageDirectory = [];
		this.pageIndex = 0;
		this._lastStatistics = null;
		this._regionCache.clear();
		this._regionCacheBytes = 0;
		this._sceneGeneration++;
	}

	protected _cacheRegion(level: number, x: number, y: number, width: number, height: number, channels: number, data: Float32Array): void {
		const bytes = data.byteLength;
		if (!(bytes > 0) || bytes > REGION_CACHE_MAX_BYTES) { return; }
		const key = `${level}:${x}:${y}:${width}:${height}`;
		const previous = this._regionCache.get(key);
		if (previous) { this._regionCacheBytes -= previous.bytes; }
		this._regionCache.delete(key);
		this._regionCache.set(key, { level, x, y, width, height, channels, data, bytes });
		this._regionCacheBytes += bytes;
		while (this._regionCacheBytes > REGION_CACHE_MAX_BYTES) {
			// Keep the overview's samples: it stays visible under every detail tile.
			const oldest = [...this._regionCache.entries()].find(([, region]) => region.level !== this.pageIndex);
			if (!oldest) { break; }
			this._regionCache.delete(oldest[0]);
			this._regionCacheBytes -= oldest[1].bytes;
		}
	}

	private _formatSamples(samples: number[]): string {
		const integer = this.numericDomain.sampleFormat !== 3;
		return samples.map(value => Number.isNaN(value) ? 'NaN' : integer ? String(value) : value.toPrecision(4)).join(' ');
	}

	private _readCached(level: number, x: number, y: number): string | null {
		for (const [key, region] of this._regionCache) {
			if (region.level !== level || x < region.x || y < region.y || x >= region.x + region.width || y >= region.y + region.height) { continue; }
			this._regionCache.delete(key);
			this._regionCache.set(key, region);
			const offset = ((y - region.y) * region.width + (x - region.x)) * region.channels;
			return this._formatSamples(Array.from(region.data.subarray(offset, offset + region.channels)));
		}
		return null;
	}

	/** Best already-decoded value at a full-resolution coordinate, finest level first. Never reads. */
	readCachedScenePixel(x: number, y: number): { value: string, exact: boolean } | null {
		for (const level of this.pageDirectory) {
			const reduction = Math.max(1, level.reduction);
			const value = this._readCached(level.index, Math.floor(x / reduction), Math.floor(y / reduction));
			if (value !== null) { return { value, exact: reduction === 1 }; }
		}
		return null;
	}

	/** Exact full-resolution value; decodes and keeps the block around it. */
	async readFullResolutionPixel(x: number, y: number): Promise<string | null> {
		const storedX = Math.floor(x);
		const storedY = Math.floor(y);
		const cached = this._readCached(0, storedX, storedY);
		if (cached !== null) { return cached; }
		const full = this.pageDirectory[0];
		if (!full || storedX < 0 || storedY < 0 || storedX >= full.width || storedY >= full.height) { return null; }
		const rect = {
			x: Math.floor(storedX / READOUT_BLOCK) * READOUT_BLOCK,
			y: Math.floor(storedY / READOUT_BLOCK) * READOUT_BLOCK,
			width: 0, height: 0,
		};
		rect.width = Math.min(READOUT_BLOCK, full.width - rect.x);
		rect.height = Math.min(READOUT_BLOCK, full.height - rect.y);
		const region = await this._decodeLevelRegion(0, rect);
		return region ? this._readCached(0, storedX, storedY) : null;
	}

	async readStoredPixel(x: number, y: number): Promise<string | null> {
		const reduction = this.pageDirectory[this.pageIndex]?.reduction ?? 1;
		return this.isScene ? this.readFullResolutionPixel(x * reduction, y * reduction) : null;
	}

	private async _decodeLevelRegion(levelIndex: number, rect: SceneRect, signal?: AbortSignal): Promise<SceneRegion | null> {
		if (!this.pageDirectory[levelIndex]) { return null; }
		const generation = this._sceneGeneration;
		const decoded = await this._readLevelRegion(levelIndex, rect, signal);
		if (generation !== this._sceneGeneration || signal?.aborted || !decoded?.data?.length) { return null; }
		this._cacheRegion(levelIndex, rect.x, rect.y, decoded.width, decoded.height, decoded.channels, decoded.data);
		return decoded;
	}

	/** A level rectangle rendered with the image-wide statistics, as the scene paints it. */
	async renderRegion(levelIndex: number, rect: SceneRect, signal?: AbortSignal): Promise<ImageData | null> {
		try {
			const region = await this._decodeLevelRegion(levelIndex, rect, signal);
			if (!region || signal?.aborted) { return null; }
			const settings = this.settingsManager.settings;
			const stats = this._cachedStats || this._decodedStats || this._lastStatistics || undefined;
			return ImageRenderer.render(
				region.data, region.width, region.height, region.channels, true,
				NormalizationHelper.needsStats(settings) && stats ? stats : (stats || { min: 0, max: 1 }),
				settings,
				{
					nanColor: this._getNanColor(settings),
					typeMin: this.numericDomain.typeMin,
					typeMax: this.numericDomain.typeMax,
				} as any,
			);
		} catch (error) {
			if (!signal?.aborted) { console.warn(`[${this.config.formatLabel}] region decode failed:`, error); }
			return null;
		}
	}

	async renderRegionCanvas(levelIndex: number, rect: SceneRect, signal?: AbortSignal): Promise<ImageData | null> {
		return this.renderRegion(levelIndex, rect, signal);
	}
}
