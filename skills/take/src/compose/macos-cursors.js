ObjC.import('AppKit');

function run(argv) {
  $.NSApplication.sharedApplication;
  const [dir, jobs] = [argv[0], JSON.parse(argv[1])];
  const out = [];
  for (const job of jobs) {
    const file = `${dir}/${job.name}.png`;
    let img, hotspot;
    if (job.ns) {
      const cursor = $.NSCursor[job.ns];
      img = cursor.image;
      hotspot = [cursor.hotSpot.x, cursor.hotSpot.y];
    } else {
      img = $.NSImage.alloc.initWithContentsOfFile(job.pdf);
      if (!img || img.isNil()) continue;
    }
    const size = [img.size.width, img.size.height];
    const scale = 8;
    const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null, Math.round(size[0] * scale), Math.round(size[1] * scale), 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
    rep.size = img.size;
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
    img.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size[0], size[1]), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
    $.NSGraphicsContext.restoreGraphicsState;
    const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
    png.writeToFileAtomically(file, true);
    out.push(hotspot ? { name: job.name, file, size, hotspot } : { name: job.name, file, size });
  }
  return JSON.stringify(out);
}
