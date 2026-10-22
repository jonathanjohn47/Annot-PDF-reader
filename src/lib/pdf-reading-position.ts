export const PDF_READING_POSITION_STORAGE_KEY = 'annot-pdf-reading-positions';

function loadPositions(): Record<string, number> {
  if (typeof window === 'undefined') return {};

  try {
    const raw = window.localStorage.getItem(PDF_READING_POSITION_STORAGE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function readStoredPdfPage(pdfPath: string): number {
  const page = Number(loadPositions()[pdfPath]);
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

export function writeStoredPdfPage(pdfPath: string, page: number): void {
  if (typeof window === 'undefined' || !pdfPath) return;

  const positions = loadPositions();
  if (page <= 1) {
    delete positions[pdfPath];
  } else {
    positions[pdfPath] = page;
  }

  try {
    window.localStorage.setItem(PDF_READING_POSITION_STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // Storage full or blocked: losing the bookmark is not worth breaking the viewer.
  }
}
