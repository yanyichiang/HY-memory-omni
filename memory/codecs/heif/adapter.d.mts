export interface HeifDownsample {
  factor: number;
  strategy: 'nearest-neighbor-integer-factor-independent-grid';
  providerDerived: true;
}

export interface HeifItem {
  id: number;
  /** Original transformed item dimensions, before provider downsampling. */
  width: number;
  height: number;
  outputWidth: number;
  outputHeight: number;
  downsample: HeifDownsample | null;
}

export interface HeifInfo {
  kind: 'invalid' | 'still' | 'collection' | 'sequence';
  primaryItemId: number;
  items: HeifItem[];
  tracks: { id: number; type: string }[];
  limits: {
    inputBytes: number;
    pixels: number;
    largeGrid: {
      inputPixels: number;
      tilePixels: number;
      tiles: number;
      outputPixels: number;
      opaqueSdrOnly: boolean;
    };
    side: number;
    items: number;
    tiles: number;
    frames: number;
    wasmBytes: number;
  };
  heapBytes: number;
}

export interface HeifFrame {
  /** One copied RGBA8 provider derivative; release before requesting next frame. */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  downsample: (HeifDownsample & { scaleX: number; scaleY: number }) | null;
  index: number;
  /** Zero for untimed static items; do not invent an animation duration. */
  timescale: number;
  startTicks: bigint;
  durationTicks: bigint;
  repetitions: number;
  /** null means unavailable for this sequence API, not zero-depth/no-ICC. */
  sourceDepth: number | null;
  sourceIccBytes: number | null;
  outputNclx: { primaries: number; transfer: number };
  colorLimitation: string;
  heapBytes: number;
}

/** Caller must hold the shared image-memory permit; calls are serialized. */
export function inspectImage(bytes: Uint8Array): Promise<HeifInfo>;

/** Explicit item/track selection; no implicit primary/first frame choice. */
export function imageFrames(
  bytes: Uint8Array,
  selection: { kind: 'item' | 'sequence'; index: number },
): AsyncGenerator<HeifFrame>;
