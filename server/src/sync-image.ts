/**
 * Image side of compare_to_image, kept free of I/O and of the plugin so it can be
 * tested with generated PNGs: decode, align or resize, pixelmatch, group the
 * mismatches into regions, and rank the layers each region overlaps.
 */
import pixelmatch from "pixelmatch";
import pngjs from "pngjs";

const { PNG } = pngjs;

export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const decodePng = (bytes: Buffer): RGBAImage => {
  const png = PNG.sync.read(bytes);
  return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
};

export const encodePng = (image: RGBAImage): Buffer => {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length);
  return PNG.sync.write(png);
};

export const isPng = (b: Buffer) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
export const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;

/** jpeg-js is optional: a PNG needs nothing extra. */
export const decodeImage = async (bytes: Buffer): Promise<RGBAImage> => {
  if (isPng(bytes)) return decodePng(bytes);
  if (isJpeg(bytes)) {
    const specifier = "jpeg-js";
    let jpeg: { decode: (b: Buffer, o: object) => { width: number; height: number; data: Uint8Array } };
    try {
      const mod = await import(specifier);
      jpeg = mod.default ?? mod;
    } catch {
      throw new Error("Reading a JPG needs the optional jpeg-js package: run `bun add jpeg-js` (or `npm i jpeg-js`) in the server folder, or save the image as PNG.");
    }
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  }
  throw new Error("The image is neither a PNG nor a JPG");
};

export const crop = (image: RGBAImage, width: number, height: number): RGBAImage => {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = y * image.width * 4;
    out.set(image.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { width, height, data: out };
};

export const resizeBilinear = (image: RGBAImage, width: number, height: number): RGBAImage => {
  const out = new Uint8Array(width * height * 4);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(image.height - 1, Math.floor(fy));
    const y1 = Math.min(image.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(image.width - 1, Math.floor(fx));
      const x1 = Math.min(image.width - 1, x0 + 1);
      const wx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const p = (xx: number, yy: number) => image.data[(yy * image.width + xx) * 4 + c];
        const top = p(x0, y0) * (1 - wx) + p(x1, y0) * wx;
        const bottom = p(x0, y1) * (1 - wx) + p(x1, y1) * wx;
        out[(y * width + x) * 4 + c] = Math.round(top * (1 - wy) + bottom * wy);
      }
    }
  }
  return { width, height, data: out };
};

export interface Comparison {
  width: number;
  height: number;
  resized: boolean;
  mismatchedPixels: number;
  mismatchPercent: number;
  diff: RGBAImage;
  /** 1 where pixelmatch counted a real difference (anti-aliasing excluded). */
  mask: Uint8Array;
}

export function compareImages(
  design: RGBAImage,
  actual: RGBAImage,
  options: { threshold?: number; fit?: "crop" | "resize" } = {}
): Comparison {
  let a = design;
  let b = actual;
  let resized = false;
  if (design.width !== actual.width || design.height !== actual.height) {
    if (options.fit === "resize") {
      b = resizeBilinear(actual, design.width, design.height);
      resized = true;
    } else {
      const w = Math.min(design.width, actual.width);
      const h = Math.min(design.height, actual.height);
      a = crop(design, w, h);
      b = crop(actual, w, h);
    }
  }
  const { width, height } = a;
  const diff = new Uint8Array(width * height * 4);
  const mismatchedPixels = pixelmatch(a.data, b.data, diff, width, height, {
    threshold: options.threshold ?? 0.1,
    includeAA: false,
    diffColor: [255, 0, 0],
    aaColor: [255, 255, 0],
  });
  // pixelmatch paints real differences pure red over a greyscale copy, and a
  // greyscale pixel always has r = g = b, so red identifies them exactly.
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    if (diff[o] === 255 && diff[o + 1] === 0 && diff[o + 2] === 0) mask[i] = 1;
  }
  const area = width * height;
  return {
    width,
    height,
    resized,
    mismatchedPixels,
    mismatchPercent: area ? Math.round((mismatchedPixels / area) * 10000) / 100 : 0,
    diff: { width, height, data: diff },
    mask,
  };
}

export interface Region {
  box: Box;
  mismatchedPixels: number;
  percentOfRegion: number;
}

/**
 * Connected mismatch regions: count mismatches per `cell`×`cell` block, flood
 * fill neighbouring non-empty blocks (8-connected), and report each group's
 * tight pixel bounding box, largest first.
 */
export function findRegions(
  mask: Uint8Array,
  width: number,
  height: number,
  options: { cell?: number; minPixels?: number; maxRegions?: number } = {}
): Region[] {
  const cell = Math.max(1, Math.round(options.cell ?? 8));
  const minPixels = options.minPixels ?? 4;
  const gw = Math.ceil(width / cell);
  const gh = Math.ceil(height / cell);
  const count = new Uint32Array(gw * gh);
  const minX = new Int32Array(gw * gh).fill(0x7fffffff);
  const minY = new Int32Array(gw * gh).fill(0x7fffffff);
  const maxX = new Int32Array(gw * gh).fill(-1);
  const maxY = new Int32Array(gw * gh).fill(-1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      const g = Math.floor(y / cell) * gw + Math.floor(x / cell);
      count[g]++;
      if (x < minX[g]) minX[g] = x;
      if (y < minY[g]) minY[g] = y;
      if (x > maxX[g]) maxX[g] = x;
      if (y > maxY[g]) maxY[g] = y;
    }
  }
  const seen = new Uint8Array(gw * gh);
  const regions: Region[] = [];
  for (let start = 0; start < count.length; start++) {
    if (!count[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let pixels = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    while (stack.length) {
      const g = stack.pop()!;
      pixels += count[g];
      x0 = Math.min(x0, minX[g]);
      y0 = Math.min(y0, minY[g]);
      x1 = Math.max(x1, maxX[g]);
      y1 = Math.max(y1, maxY[g]);
      const gx = g % gw;
      const gy = (g - gx) / gw;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = gx + dx;
          const ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const n = ny * gw + nx;
          if (count[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    if (pixels < minPixels) continue;
    const box = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
    regions.push({ box, mismatchedPixels: pixels, percentOfRegion: Math.round((pixels / (box.width * box.height)) * 10000) / 100 });
  }
  regions.sort((p, q) => q.mismatchedPixels - p.mismatchedPixels);
  return regions.slice(0, options.maxRegions ?? 5);
}

export interface LayerBox {
  id: string;
  name: string;
  type: string;
  path?: string;
  depth?: number;
  relativeToRoot?: Box;
}

export interface Culprit {
  id: string;
  name: string;
  type: string;
  path?: string;
  /** Share of the region this layer covers. */
  coversRegion: number;
  /** Share of the layer inside the region. */
  insideRegion: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The most specific layers for a region: those whose box both covers much of
 * the region and is mostly inside it. A page-wide frame covers every region but
 * is barely inside any, so it ranks low; the changed layer itself ranks first.
 */
export function likelyLayers(region: Box, layers: LayerBox[], top = 3): Culprit[] {
  const regionArea = Math.max(1e-9, region.width * region.height);
  return layers
    .flatMap((layer) => {
      const b = layer.relativeToRoot;
      if (!b || b.width <= 0 || b.height <= 0) return [];
      const w = Math.min(region.x + region.width, b.x + b.width) - Math.max(region.x, b.x);
      const h = Math.min(region.y + region.height, b.y + b.height) - Math.max(region.y, b.y);
      if (w <= 0 || h <= 0) return [];
      const overlap = w * h;
      const coversRegion = Math.min(1, overlap / regionArea);
      const insideRegion = Math.min(1, overlap / (b.width * b.height));
      return [{ layer, coversRegion, insideRegion, score: coversRegion * insideRegion }];
    })
    .sort((p, q) => q.score - p.score || (q.layer.depth ?? 0) - (p.layer.depth ?? 0))
    .slice(0, top)
    .map(({ layer, coversRegion, insideRegion }) => ({
      id: layer.id,
      name: layer.name,
      type: layer.type,
      ...(layer.path ? { path: layer.path } : {}),
      coversRegion: round2(coversRegion),
      insideRegion: round2(insideRegion),
    }));
}

export const scaleBox = (box: Box, factor: number): Box => ({
  x: round2(box.x / factor),
  y: round2(box.y / factor),
  width: round2(box.width / factor),
  height: round2(box.height / factor),
});
