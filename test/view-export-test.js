const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');

function load(file) {
	const result = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false });
	const loaded = { exports: {} };
	new Function('module', 'exports', 'require', result.outputFiles[0].text)(loaded, loaded.exports, require);
	return loaded.exports;
}

const { viewFrame, exportSize, paintView, frameScaleBarPlacement, MAX_EXPORT_AXIS } = load('media/modules/view-export.ts');
const { viewFileName, ViewCaptureChannel } = load('src/imagePreview/viewCapture.ts');

function recorder() {
	const calls = [];
	const ctx = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); } });
	return { ctx, calls };
}

function testFrameIsImageCutToViewport() {
	assert.deepEqual(viewFrame({ left: 10, top: 20, width: 100, height: 50 }, { width: 800, height: 600 }), { left: 10, top: 20, width: 100, height: 50 }, 'an image inside the viewport is exported whole');
	assert.deepEqual(viewFrame({ left: -300, top: -100, width: 2000, height: 1000 }, { width: 800, height: 600 }), { left: 0, top: 0, width: 800, height: 600 }, 'a zoomed image is cut to the viewport');
	assert.deepEqual(viewFrame({ left: -50, top: 100, width: 400, height: 2000 }, { width: 800, height: 600 }), { left: 0, top: 100, width: 350, height: 500 }, 'each edge is cut independently');
	assert.deepEqual(viewFrame({ left: 0, top: 0, width: 800, height: 600 }, { width: 800, height: 600 }, 22), { left: 0, top: 0, width: 800, height: 578 }, 'fixed chrome at the bottom is not part of the view');
	assert.equal(viewFrame({ left: 900, top: 0, width: 100, height: 100 }, { width: 800, height: 600 }), null, 'an image panned out of view has nothing to export');
}

function testSizeAndLimits() {
	assert.deepEqual(exportSize({ left: 0, top: 0, width: 800, height: 600 }, 1), { width: 800, height: 600, scale: 1 });
	assert.deepEqual(exportSize({ left: 0, top: 0, width: 800, height: 600 }, 2), { width: 1600, height: 1200, scale: 2 });
	assert.equal(exportSize({ left: 0, top: 0, width: 800, height: 600 }, Number.NaN).scale, 1, 'a bad scale falls back to 1');
	const huge = exportSize({ left: 0, top: 0, width: 20000, height: 100 }, 1);
	assert.ok(huge.width <= MAX_EXPORT_AXIS && huge.scale < 1, 'a frame past the canvas limit is scaled down, not refused');
	const area = exportSize({ left: 0, top: 0, width: 16000, height: 16000 }, 2);
	assert.ok(area.width * area.height <= 268435456, 'the pixel budget holds');
}

function testPaintOrderAndIsolation() {
	const { ctx, calls } = recorder();
	const order = [];
	const frame = { left: 100, top: 50, width: 400, height: 300 };
	paintView(ctx, frame, 2, [() => order.push('base'), () => order.push('overlay')]);
	assert.deepEqual(order, ['base', 'overlay'], 'painters run in the order given');
	const transforms = calls.filter(call => call[0] === 'setTransform');
	assert.equal(transforms.length, 2, 'every painter starts from its own transform');
	assert.deepEqual(transforms[0].slice(1), [2, 0, 0, 2, -200, -100], 'viewport pixels map to output pixels with the frame at the origin');
	assert.equal(calls.filter(call => call[0] === 'save').length, calls.filter(call => call[0] === 'restore').length, 'state is restored after each painter');
}

function testScaleBarFollowsTheFrame() {
	const input = {
		pixelScale: 1, calibration: { pixelWidth: 0.5, pixelHeight: 0.5, unit: 'µm', origin: 'imported' }, position: null,
		imageRect: { left: 200, top: 100, width: 600, height: 400 }, anchorToImage: false,
	};
	const frame = { left: 200, top: 100, width: 600, height: 400 };
	const placed = frameScaleBarPlacement(frame, input);
	assert.deepEqual([placed.x, placed.y], [16, 384], 'the viewer\'s lower-left corner becomes the export\'s lower-left corner');
	const anchored = frameScaleBarPlacement(frame, { ...input, anchorToImage: true });
	assert.ok(anchored.x >= 0 && anchored.y <= 400, 'an image-anchored bar stays inside the exported frame');
	assert.equal(frameScaleBarPlacement(frame, { ...input, calibration: { pixelWidth: 1, pixelHeight: 1, unit: 'px', origin: 'none' } }), null, 'an uncalibrated view has no bar');
}

function testFileName() {
	assert.equal(viewFileName('/data/slides/tissue.ome.tif'), 'tissue.ome.view.png');
	assert.equal(viewFileName('C:\\data\\scan.tiff', 2), 'scan.view@2x.png');
	assert.equal(viewFileName(''), 'image.view.png');
}

testFrameIsImageCutToViewport();
testSizeAndLimits();
testPaintOrderAndIsolation();
testScaleBarFollowsTheFrame();
testFileName();

async function testCaptureChannel() {
	const posted = [];
	const channel = new ViewCaptureChannel(message => posted.push(message), 50);
	const first = channel.capture({ scale: 1, overlays: true, scaleBar: true });
	const second = channel.capture({ scale: 2, overlays: false, scaleBar: false });
	assert.deepEqual(posted.map(message => message.requestId), [1, 2], 'each request has its own id');
	assert.equal(posted[1].options.scale, 2, 'the options travel with the request');
	channel.receive({ requestId: 2, payload: 'AAAA', width: 10, height: 5, scale: 2 });
	channel.receive({ requestId: 1, error: 'Nothing of the image is in view to export.' });
	assert.deepEqual(await second, { payload: 'AAAA', width: 10, height: 5, scale: 2 }, 'answers are matched by id, not by order');
	assert.deepEqual(await first, { error: 'Nothing of the image is in view to export.' }, 'an error answer is passed on');
	channel.receive({ requestId: 99, payload: 'x' });
	const silent = new ViewCaptureChannel(() => { }, 20).capture({ scale: 1, overlays: true, scaleBar: true });
	assert.ok('error' in await silent, 'a viewer that never answers times out instead of hanging the command');
	const closing = new ViewCaptureChannel(() => { }, 5000);
	const waiting = closing.capture({ scale: 1, overlays: true, scaleBar: true });
	closing.dispose();
	assert.deepEqual(await waiting, { error: 'The viewer was closed.' }, 'closing the viewer releases a waiting command');
}

testCaptureChannel().then(() => console.log('view-export tests passed'));
