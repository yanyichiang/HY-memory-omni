export interface WordMeasurement {
  raw: string;
  type: 'explicit' | 'initial-grid-width' | 'preferred-width-dxa' | 'explicit-font-size';
  unit: 'twip' | 'half-point';
  value: number;
  points: number;
  inches: number;
}
/** Only explicit supported Word attributes; no style inheritance or effective layout. */
export function wordMeasurements(node: {
  local: string; uri: string;
  attributes?: { local: string; uri: string; value: string }[];
} | undefined): Record<string, WordMeasurement> | undefined;
