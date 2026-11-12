/**
 * Detail for pyramidal layers (NDPI slides, CZI mosaics) in a layer stack.
 *
 * A stack composites each layer's overview on one canvas. Finer pyramid levels
 * cannot simply be drawn over that canvas: a detail tile of layer 1 laid on top
 * would also cover layer 2. Instead the stack is composited again, per tile, on
 * a finer grid: every layer contributes its own finest suitable level (or its
 * overview, resampled, when it has no finer one), and the ordinary compositor
 * stacks them. A layer's detail therefore sits above the layers below it and
 * under the layers above it, with their blend modes, opacities and filters.
 *
 * Coordinates: "canvas" pixels are those of the stack (the base overview).
 * The grid has `plan.grid` pixels per canvas pixel. A layer's data is in its
 * own overview pixels at (offsetX, offsetY); a level of its pyramid is
 * `level.width / layer.width` level pixels per overview pixel.
 *
 * Pure arithmetic and the compositor only: no DOM and no decoder.
 */
import { composite, type CompositeResult, type Layer } from './layer-compositor.js';

export interface DetailLevel { index: number; width: number; height: number }
export interface DetailRegion { width: number; height: number; channels: number; data: ArrayLike<number> }
export interface DetailRect { x: number; y: number; width: number; height: number }

/** Where a layer's finer levels come from. */
export interface LayerDetailSource {
	/** Stored levels, finest first. */
	levels: DetailLevel[];
	/** Samples of `rect` (level pixels) of the level with this `index`, in the layer's own numeric domain. */
	readRegion(levelIndex: number, rect: DetailRect, signal?: AbortSignal): Promise<DetailRegion | null>;
}

export interface DetailPlan {
	/** Grid pixels per canvas pixel; above 1 whenever any layer has finer detail to show. */
	grid: number;
	/** Chosen level per layer id: undefined when the layer is drawn from its overview. */
	levels: Map<string, DetailLevel | undefined>;
}

/** Layers whose pixels this module resamples. Everything else is passed through. */
const isRaster = (layer: Layer): boolean => !!layer.data && layer.kind !== 'adjustment' && layer.kind !== 'group';

/** Detail only composites a flat stack: group surfaces would need resampling of their own. */
export function supportsLayerDetail(layers: readonly Layer[]): boolean {
	return layers.some(layer => !!layer.detail && layer.visible !== false)
		&& !layers.some(layer => layer.kind === 'group');
}

/** Level pixels per overview pixel of `layer` at `level`. */
function levelRatio(layer: Layer, level: DetailLevel): { x: number; y: number } {
	return { x: level.width / Math.max(1, layer.width), y: level.height / Math.max(1, layer.height) };
}

/**
 * Pick, for a view that shows `scale` screen pixels per canvas pixel, the
 * coarsest level of each layer that is at least that sharp, and the grid that
 * keeps the sharpest of them. Null when no layer has anything finer than its
 * overview to offer at this zoom.
 */
export function planDetail(layers: readonly Layer[], scale: number, maxGrid = 64): DetailPlan | null {
	if (!(scale > 1)) { return null; }
	const levels = new Map<string, DetailLevel | undefined>();
	let grid = 1;
	for (const layer of layers) {
		const source = layer.detail;
		if (!source || !isRaster(layer) || layer.visible === false || !layer.id) { continue; }
		let chosen: DetailLevel | undefined;
		// Finest first: the last level that is still no sharper than needed is
		// the coarsest sufficient one; if none is, the finest available.
		for (let at = source.levels.length - 1; at >= 0; at--) {
			const level = source.levels[at];
			const ratio = levelRatio(layer, level);
			if (Math.min(ratio.x, ratio.y) <= 1) { continue; }
			chosen = level;
			if (Math.min(ratio.x, ratio.y) >= scale) { break; }
		}
		levels.set(layer.id, chosen);
		if (chosen) {
			const ratio = levelRatio(layer, chosen);
			grid = Math.max(grid, Math.min(maxGrid, ratio.x, ratio.y));
		}
	}
	return grid > 1 ? { grid, levels } : null;
}

type Plane = { data: ArrayLike<number>; width: number; height: number; channels: number; originX: number; originY: number; ratioX: number; ratioY: number };

function allocate(like: ArrayLike<number>, length: number): { [index: number]: number; length: number } {
	if (ArrayBuffer.isView(like) && !(like instanceof DataView)) {
		const Constructor = like.constructor as new (length: number) => { [index: number]: number; length: number };
		return new Constructor(length);
	}
	return new Float32Array(length);
}

/**
 * Nearest-neighbour resampling of `plane` onto the grid pixels that cover
 * canvas rectangle `area`, so a level pixel stays the square it is.
 * `plane.originX/Y` is where its data starts, in level pixels; `ratio*` is level
 * pixels per canvas pixel; `anchorX/Y` is the canvas position of level pixel 0.
 */
function resample(plane: Plane, anchorX: number, anchorY: number, area: DetailRect, gridX: number, gridY: number, outWidth: number, outHeight: number): ArrayLike<number> {
	const channels = plane.channels;
	const out = allocate(plane.data, outWidth * outHeight * channels);
	for (let v = 0; v < outHeight; v++) {
		const canvasY = area.y + (v + 0.5) / gridY;
		const row = Math.min(plane.height - 1, Math.max(0, Math.floor((canvasY - anchorY) * plane.ratioY) - plane.originY));
		for (let u = 0; u < outWidth; u++) {
			const canvasX = area.x + (u + 0.5) / gridX;
			const column = Math.min(plane.width - 1, Math.max(0, Math.floor((canvasX - anchorX) * plane.ratioX) - plane.originX));
			const from = (row * plane.width + column) * channels;
			const to = (v * outWidth + u) * channels;
			for (let c = 0; c < channels; c++) { out[to + c] = plane.data[from + c]; }
		}
	}
	return out;
}

/** The part of `layer` inside canvas rectangle `tile`, in whole canvas pixels, or null. */
function overlap(layer: Layer, tile: DetailRect): DetailRect | null {
	const offsetX = Math.round(layer.offsetX ?? 0);
	const offsetY = Math.round(layer.offsetY ?? 0);
	const x0 = Math.max(tile.x, offsetX), y0 = Math.max(tile.y, offsetY);
	const x1 = Math.min(tile.x + tile.width, offsetX + layer.width), y1 = Math.min(tile.y + tile.height, offsetY + layer.height);
	return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/**
 * The stack composited over canvas rectangle `tile` on the detail grid, or null
 * if the request was aborted or a layer's level could not be read.
 */
export async function compositeDetailTile(
	layers: readonly Layer[],
	tile: DetailRect,
	plan: DetailPlan,
	signal?: AbortSignal,
): Promise<CompositeResult | null> {
	const outWidth = Math.max(1, Math.round(tile.width * plan.grid));
	const outHeight = Math.max(1, Math.round(tile.height * plan.grid));
	const gridX = outWidth / tile.width;
	const gridY = outHeight / tile.height;

	const prepared = await Promise.all(layers.map(async (layer): Promise<Layer | null> => {
		// Filters and groups work per pixel of whatever grid they are given, and
		// invisible layers are skipped by the compositor: all pass through.
		if (!isRaster(layer) || layer.visible === false) { return layer; }
		const area = overlap(layer, tile);
		if (!area) { return { ...layer, data: undefined, width: 0, height: 0, rasterMask: undefined }; }
		const offsetX = Math.round(layer.offsetX ?? 0);
		const offsetY = Math.round(layer.offsetY ?? 0);
		const level = layer.id ? plan.levels.get(layer.id) : undefined;
		let plane: Plane;
		if (level && layer.detail) {
			const ratio = levelRatio(layer, level);
			const rect = {
				x: Math.max(0, Math.floor((area.x - offsetX) * ratio.x)),
				y: Math.max(0, Math.floor((area.y - offsetY) * ratio.y)),
				width: 0, height: 0,
			};
			rect.width = Math.min(level.width, Math.ceil((area.x + area.width - offsetX) * ratio.x)) - rect.x;
			rect.height = Math.min(level.height, Math.ceil((area.y + area.height - offsetY) * ratio.y)) - rect.y;
			if (!(rect.width > 0 && rect.height > 0)) { return null; }
			const region = await layer.detail.readRegion(level.index, rect, signal);
			if (!region?.data?.length) { return null; }
			plane = { data: region.data, width: region.width, height: region.height, channels: region.channels,
				originX: rect.x, originY: rect.y, ratioX: ratio.x, ratioY: ratio.y };
		} else {
			plane = { data: layer.data!, width: layer.width, height: layer.height, channels: layer.channels,
				originX: 0, originY: 0, ratioX: 1, ratioY: 1 };
		}
		const width = Math.max(1, Math.round(area.width * gridX));
		const height = Math.max(1, Math.round(area.height * gridY));
		const data = resample(plane, offsetX, offsetY, area, gridX, gridY, width, height);
		const mask = layer.rasterMask;
		return {
			...layer,
			data,
			width,
			height,
			channels: plane.channels,
			offsetX: Math.round((area.x - tile.x) * gridX),
			offsetY: Math.round((area.y - tile.y) * gridY),
			// A mask is authored in canvas pixels, so it follows the same grid.
			rasterMask: mask ? scaleMask(mask, offsetX, offsetY, area, tile, gridX, gridY, width, height) : undefined,
			detail: undefined,
		};
	}));
	if (signal?.aborted || prepared.some(layer => layer === null)) { return null; }
	const stack = (prepared as Layer[]).filter(layer => layer.width > 0 || layer.kind === 'adjustment');
	return composite(stack, outWidth, outHeight);
}

function scaleMask(mask: NonNullable<Layer['rasterMask']>, layerX: number, layerY: number, area: DetailRect, tile: DetailRect, gridX: number, gridY: number, width: number, height: number): NonNullable<Layer['rasterMask']> {
	const channels = mask.channels ?? 1;
	const maskX = Math.round(mask.offsetX ?? layerX);
	const maskY = Math.round(mask.offsetY ?? layerY);
	const data = resample(
		{ data: mask.data, width: mask.width, height: mask.height, channels, originX: 0, originY: 0, ratioX: 1, ratioY: 1 },
		maskX, maskY, area, gridX, gridY, width, height,
	);
	// Resampled over exactly the layer's own area, so it starts where the layer does.
	return { ...mask, data, width, height, offsetX: Math.round((area.x - tile.x) * gridX), offsetY: Math.round((area.y - tile.y) * gridY) };
}
