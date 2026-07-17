export const SIGNATURE_CANVAS_DPI = 2;
export const SIGNATURE_MIN_COVERAGE_THRESHOLD = 0.01;

export const isBase64Image = (value: string) =>
  value.startsWith('data:image/png;base64,') || value.startsWith('data:image/jpeg;base64,');
