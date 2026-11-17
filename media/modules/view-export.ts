"use strict";

import { paintScaleBar, placeScaleBar } from './scale-bar.js';
import type { ScaleBarInput, ScaleBarPosition } from './scale-bar.js';

/**
 * Export of the current view: the part of the image the user is looking at,
 * with the overlays drawn over it. Both viewers share this module. Each one
 * knows where its pixels are and how to paint its overlays; this module owns
 * what is common: which rectangle is exported, how large the output is, the
 * order of painting, and the scale bar placed for the exported frame.
 */

export interface ViewRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface ViewOptions {
	/** Output pixels per screen pixel. 1 is what the screen shows, 2 doubles it. */
	scale: number;
	/** Cell outlines, transcripts and ROIs. */
	overlays: boolean;
	scaleBar: boolean;
}

export const DEFAULT_VIEW_OPTIONS: ViewOptions = { scale: 1, overlays: true, scaleBar: true };

/** Chromium backs a 2D canvas up to 16384 pixels on a side and 2^28 pixels overall. */
export const MAX_EXPORT_AXIS = 16384;
export const MAX_EXPORT_AREA = 268_435_456;

/** The part of the image that is on screen: the image rectangle cut to the viewport. */
export function viewFrame(image: ViewRect, viewport: { width: number; height: number }, bottomInset = 0): ViewRect | null {
	const left = Math.max(0, image.left);
	const top = Math.max(0, image.top);
	const right = Math.min(viewport.width, image.left + image.width);
	const bottom = Math.min(viewport.height - bottomInset, image.top + image.height);
	if (!(right - left >= 1) || !(bottom - top >= 1)) { return null; }
	return { left, top, width: right - left, height: bottom - top };
}

export interface ExportSize {
	width: number;
	height: number;
	/** The scale actually used, which is lower than the one asked for when the canvas limit applies. */
	scale: number;
}

/** Output size in pixels, with the scale lowered until the canvas can be created. */
export function exportSize(frame: ViewRect, requested: number): ExportSize {
	let scale = Number.isFinite(requested) && requested > 0 ? requested : 1;
	scale = Math.min(scale, MAX_EXPORT_AXIS / frame.width, MAX_EXPORT_AXIS / frame.height, Math.sqrt(MAX_EXPORT_AREA / (frame.width * frame.height)));
	let width = Math.max(1, Math.floor(frame.width * scale));
	let height = Math.max(1, Math.floor(frame.height * scale));
	while (width > MAX_EXPORT_AXIS || height > MAX_EXPORT_AXIS || width * height > MAX_EXPORT_AREA) {
		scale *= 0.999;
		width = Math.max(1, Math.floor(frame.width * scale));
		height = Math.max(1, Math.floor(frame.height * scale));
	}
	return { width, height, scale };
}

/**
 * Paints one layer of the view. The context is set up so that its units are
 * the viewer's own screen pixels, the same ones `getBoundingClientRect()`
 * reports; the exported frame is a window onto them.
 */
export type ViewPainter = (ctx: CanvasRenderingContext2D, frame: ViewRect) => void;

/** Paint the painters in order, base pixels first. Each starts from the same transform and cannot leak state to the next. */
export function paintView(ctx: CanvasRenderingContext2D, frame: ViewRect, scale: number, painters: ViewPainter[]): void {
	for (const painter of painters) {
		ctx.save();
		ctx.setTransform(scale, 0, 0, scale, -frame.left * scale, -frame.top * scale);
		ctx.beginPath();
		ctx.rect(frame.left, frame.top, frame.width, frame.height);
		ctx.clip();
		painter(ctx, frame);
		ctx.restore();
	}
}

export type FrameScaleBarInput = Omit<ScaleBarInput, 'viewportWidth' | 'viewportHeight' | 'bottomInset' | 'bottomClearance' | 'position' | 'visibleWidth'> & { position: ScaleBarPosition | null };

/**
 * The scale bar for an exported frame. The frame, not the window, is the
 * viewport, so a bar kept in the lower-left corner of the viewer lands in the
 * lower-left corner of the export even when the image is smaller than the window.
 */
export function frameScaleBarPlacement(frame: ViewRect, input: FrameScaleBarInput) {
	return placeScaleBar({
		...input,
		visibleWidth: frame.width / input.pixelScale,
		imageRect: input.imageRect ? { left: input.imageRect.left - frame.left, top: input.imageRect.top - frame.top, width: input.imageRect.width, height: input.imageRect.height } : undefined,
		viewportWidth: frame.width,
		viewportHeight: frame.height,
		bottomInset: 0,
	});
}

export function frameScaleBarPainter(input: FrameScaleBarInput): ViewPainter {
	return (ctx, frame) => {
		const placement = frameScaleBarPlacement(frame, input);
		if (!placement) { return; }
		ctx.save();
		ctx.translate(frame.left, frame.top);
		paintScaleBar(ctx, placement);
		ctx.restore();
	};
}

/** Draw every image or canvas under `element` (or `element` itself) at its on-screen rectangle. */
export function paintElementPixels(ctx: CanvasRenderingContext2D, element: Element): void {
	const sources: Element[] = element.matches('img, canvas') ? [element] : Array.from(element.querySelectorAll('canvas, img'));
	for (const source of sources) {
		const rect = source.getBoundingClientRect();
		if (!(rect.width > 0) || !(rect.height > 0)) { continue; }
		if (getComputedStyle(source).visibility === 'hidden') { continue; }
		ctx.imageSmoothingEnabled = getComputedStyle(source).imageRendering !== 'pixelated';
		try {
			ctx.drawImage(source as CanvasImageSource, rect.left, rect.top, rect.width, rect.height);
		} catch {
			// A canvas that cannot be read (a lost context) leaves a hole, not a failed export.
		}
	}
}

export function createViewCanvas(frame: ViewRect, requested: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; size: ExportSize } | null {
	const size = exportSize(frame, requested);
	const canvas = document.createElement('canvas');
	canvas.width = size.width;
	canvas.height = size.height;
	const ctx = canvas.getContext('2d');
	return ctx ? { canvas, ctx, size } : null;
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The view could not be encoded as PNG.')), 'image/png');
	});
}

export async function blobToBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = '';
	for (let at = 0; at < bytes.length; at += 0x8000) { binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000)); }
	return btoa(binary);
}
