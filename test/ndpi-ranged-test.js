/**
 * Hamamatsu NDPI through ranged reads (formats/ndpi.rs, driven by
 * media/modules/ndpi-source.ts): the page reads the slide's directories once
 * and then only the JPEG restart intervals each view covers.
 *
 * This runs the page's loop against the WASM entry points for the repository
 * fixture: layout, byte plan and region decode for every selectable image,
 * requiring each result to equal the whole-file decode bit for bit, a tile to
 * equal the same rectangle of its level, and a tile to cost a fraction of the
 * level's bytes.
 *
 * Real slides are too large to commit. Any `.ndpi` under test-samples/ndpi/
 * (for example CMU-1.ndpi from the OpenSlide test data) is opened the same
 * way, without ever being read whole: its overview and full-resolution tiles
 * must decode, and each tile must agree with the next pyramid level.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const NEED = /\[need-range:(\d+):(\d+)\]/;

/** The viewer's side of the protocol: an index of directory pieces that grows on demand. */
function openSlide(wasm, file) {
	const size = fs.statSync(file).size;
	const fd = fs.openSync(file, 'r');
	const read = (offset, length) => {
		const bytes = Buffer.alloc(Math.min(length, size - offset));
		fs.readSync(fd, bytes, 0, bytes.length, offset);
		return new Uint8Array(bytes);
	};
	const index = [{ offset: 0, bytes: read(0, 4096) }];
	const stats = { size, indexBytes: 4096, dataBytes: 0, trips: 0 };
	const request = (name, options, data = []) => {
		for (let trip = 0; trip <= 1024; trip++) {
			const pieces = [...index, ...data];
			const blob = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.bytes.length, 0));
			let at = 0;
			for (const piece of pieces) { blob.set(piece.bytes, at); at += piece.bytes.length; }
			try {
				return wasm[name](blob, Float64Array.from(pieces.map(piece => piece.offset)),
					Uint32Array.from(pieces.map(piece => piece.bytes.length)), size, JSON.stringify(options));
			} catch (error) {
				const need = NEED.exec(String(error?.message ?? error));
				if (!need) { throw error; }
				assert.ok(data.length === 0, `${name}: the byte plan left out ${need[0]}`);
				const bytes = read(Number(need[1]), Number(need[2]));
				stats.indexBytes += bytes.length;
				stats.trips++;
				index.push({ offset: Number(need[1]), bytes });
			}
		}
		throw new Error('too many reads');
	};
	return {
		stats,
		close: () => fs.closeSync(fd),
		layout: indices => JSON.parse(request('ndpi_layout', { indices })),
		region(options) {
			const plan = JSON.parse(request('ndpi_region_plan', options));
			const data = plan.ranges.map(([offset, length]) => ({ offset, bytes: read(offset, length) }));
			const planned = data.reduce((sum, piece) => sum + piece.bytes.length, 0);
			stats.dataBytes += planned;
			// A need-range here would mean the plan was incomplete; `request` asserts.
			return { plan, planned, result: request('decode_ndpi_ranged', options, data) };
		},
	};
}

function samples(result) {
	return { width: result.width, height: result.height, channels: result.channels, data: result.take_data_as_f32() };
}

function checkFixture(wasm) {
	const file = path.join(root, 'test-samples', 'scientific', 'synthetic-slide.ndpi');
	assert.ok(fs.existsSync(file), 'synthetic-slide.ndpi is missing; run scripts/make-ndpi-testdata.py');
	const whole = new Uint8Array(fs.readFileSync(file));
	const slide = openSlide(wasm, file);

	const layout = slide.layout({});
	assert.deepEqual([layout.width, layout.height, layout.channels], [640, 480, 3]);
	assert.deepEqual(layout.levels.map(level => level.factor), [1, 4]);
	assert.deepEqual(layout.levels.map(level => level.randomAccess), [true, false]);
	const metadata = JSON.parse(layout.metadataJson);
	assert.deepEqual(metadata.selectors.map(selector => selector.name), ['S', 'Z']);
	assert.deepEqual(metadata.selectedIndices, { S: 0, Z: 1 });

	let compared = 0;
	for (const indices of [{}, { Z: 0 }, { Z: 1 }, { S: 1 }]) {
		const levels = slide.layout(indices).levels;
		for (let level = 0; level < levels.length; level++) {
			const options = { indices, level };
			const ranged = slide.region(options).result;
			const direct = wasm.decode_ndpi_fast(whole, JSON.stringify(options));
			const label = `${JSON.stringify(indices)} level ${level}`;
			for (const key of ['width', 'height', 'channels', 'bits_per_sample', 'sample_format', 'type_min', 'type_max', 'source_numeric_type', 'metadata_json', 'data_min', 'data_max']) {
				assert.deepEqual(ranged[key], direct[key], `${label}: ${key}`);
			}
			assert.deepEqual([ranged.width, ranged.height], [levels[level].width, levels[level].height], label);
			assert.ok(Buffer.from(direct.take_data_as_f32().buffer).equals(Buffer.from(ranged.take_data_as_f32().buffer)), `${label}: samples differ`);
			compared++;
		}
	}

	// A tile is that rectangle of its level, and costs a fraction of the level.
	const level0 = samples(slide.region({ indices: {}, level: 0 }).result);
	const fullPlan = slide.region({ indices: {}, level: 0 }).planned;
	for (const rect of [{ x: 0, y: 0, width: 128, height: 128 }, { x: 384, y: 256, width: 256, height: 224 }, { x: 250, y: 100, width: 17, height: 9 }]) {
		const tile = slide.region({ indices: {}, level: 0, rect });
		const pixels = samples(tile.result);
		assert.deepEqual([pixels.width, pixels.height], [rect.width, rect.height]);
		for (let row = 0; row < rect.height; row++) {
			const from = ((rect.y + row) * level0.width + rect.x) * 3;
			const expected = level0.data.subarray(from, from + rect.width * 3);
			const actual = pixels.data.subarray(row * rect.width * 3, (row + 1) * rect.width * 3);
			assert.ok(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)
				.equals(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength)), `tile ${JSON.stringify(rect)} row ${row}`);
		}
		assert.ok(tile.planned < fullPlan, `tile ${JSON.stringify(rect)} read ${tile.planned} of ${fullPlan} bytes`);
	}
	assert.throws(() => slide.region({ indices: { Z: 5 }, level: 0 }), /focal plane/);
	assert.throws(() => slide.region({ indices: {}, level: 0, rect: { x: 640, y: 0, width: 8, height: 8 } }), /outside/);
	slide.close();
	return `synthetic-slide.ndpi: ${compared} images identical to the whole-file decode, tiles exact`;
}

/** Mean of each channel over a rectangle of decoded samples. */
function mean(pixels, x, y, width, height) {
	const sum = [0, 0, 0];
	for (let row = y; row < y + height; row++) {
		for (let column = x; column < x + width; column++) {
			const at = (row * pixels.width + column) * pixels.channels;
			for (let channel = 0; channel < pixels.channels; channel++) { sum[channel] += pixels.data[at + channel]; }
		}
	}
	return sum.slice(0, pixels.channels).map(value => value / (width * height));
}

function checkRealSlide(wasm, file) {
	const slide = openSlide(wasm, file);
	const layout = slide.layout({});
	const levels = layout.levels;
	assert.ok(levels.length >= 1 && layout.width > 0 && layout.height > 0);
	const metadata = JSON.parse(layout.metadataJson);
	const openTrips = slide.stats.trips;
	const overviewLevel = Math.max(0, levels.findIndex(level => level.width * level.height <= 8e6));
	const overview = samples(slide.region({ indices: {}, level: overviewLevel }).result);
	assert.deepEqual([overview.width, overview.height], [levels[overviewLevel].width, levels[overviewLevel].height]);

	// Every level that reads in parts must show the same picture as the
	// overview: a tile's mean colour against the same area one level coarser.
	let tiles = 0;
	let worst = 0;
	for (let level = 0; level < overviewLevel; level++) {
		if (!levels[level].randomAccess) { continue; }
		const scale = levels[overviewLevel].factor / levels[level].factor;
		for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.4], [0.7, 0.6], [0.05, 0.05], [0.999, 0.999]]) {
			const size = Math.min(1024, levels[level].width, levels[level].height);
			const x = Math.min(levels[level].width - size, Math.floor(levels[level].width * fx / scale) * scale);
			const y = Math.min(levels[level].height - size, Math.floor(levels[level].height * fy / scale) * scale);
			const tile = samples(slide.region({ indices: {}, level, rect: { x, y, width: size, height: size } }).result);
			assert.deepEqual([tile.width, tile.height], [size, size]);
			const coarse = { x: Math.floor(x / scale), y: Math.floor(y / scale), size: Math.max(1, Math.floor(size / scale)) };
			if (coarse.x + coarse.size > overview.width || coarse.y + coarse.size > overview.height) { continue; }
			const covered = Math.min(size, coarse.size * scale);
			const fine = mean(tile, 0, 0, covered, covered);
			const reference = mean(overview, coarse.x, coarse.y, coarse.size, coarse.size);
			const difference = Math.max(...fine.map((value, channel) => Math.abs(value - reference[channel])));
			worst = Math.max(worst, difference);
			assert.ok(difference < 12, `${path.basename(file)} level ${level} tile at ${x},${y}: mean ${fine.map(v => v.toFixed(1))} vs overview ${reference.map(v => v.toFixed(1))}`);
			tiles++;
		}
	}
	for (const selector of metadata.selectors || []) {
		const last = slide.layout({ [selector.name]: selector.size - 1 });
		const level = Math.max(0, last.levels.findIndex(entry => entry.width * entry.height <= 8e6));
		const image = slide.region({ indices: { [selector.name]: selector.size - 1 }, level }).result;
		assert.ok(image.width > 0 && image.height > 0);
	}
	slide.close();
	const mb = value => (value / 1048576).toFixed(1);
	return `${path.basename(file)}: ${layout.width}x${layout.height}, levels 1/${levels.map(level => level.factor).join(' 1/')}`
		+ ` (restart intervals ${levels.map(level => level.randomAccess ? `${level.intervalWidth}x${level.intervalHeight}` : 'none').join(', ')}),`
		+ ` opened in ${openTrips} reads, ${tiles} tiles agree with the overview (worst mean difference ${worst.toFixed(1)}),`
		+ ` ${mb(slide.stats.indexBytes)} MB of index and ${mb(slide.stats.dataBytes)} MB of pixels read of ${mb(slide.stats.size)} MB`;
}

async function main() {
	const wasm = await import(path.join(root, 'media', 'wasm', 'tiff-wasm.js'));
	await wasm.default({ module_or_path: fs.readFileSync(path.join(root, 'media', 'wasm', 'tiff-wasm.wasm')) });
	const lines = [checkFixture(wasm)];
	const corpus = path.join(root, 'test-samples', 'ndpi');
	const slides = fs.existsSync(corpus) ? fs.readdirSync(corpus).filter(name => /\.ndpi$/i.test(name)).sort() : [];
	for (const name of slides) { lines.push(checkRealSlide(wasm, path.join(corpus, name))); }
	if (!slides.length) { lines.push('no real slides under test-samples/ndpi (optional)'); }
	console.log(`Ranged NDPI: ${lines.join('; ')}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
