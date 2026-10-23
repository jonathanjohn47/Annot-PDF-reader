// Per-viewer switches for PDF editing. Edits are off unless the user asks or turns Edit mode on.

export const EDIT_MODE_STORAGE_KEY = 'annot-pdf-edit-mode';
export const EDIT_AUTOAPPLY_STORAGE_KEY = 'annot-pdf-edit-autoapply-small';

function readFlag(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // preference simply is not remembered
  }
}

export const readEditMode = () => readFlag(EDIT_MODE_STORAGE_KEY);
export const writeEditMode = (value: boolean) => writeFlag(EDIT_MODE_STORAGE_KEY, value);
export const readAutoApplySmall = () => readFlag(EDIT_AUTOAPPLY_STORAGE_KEY);
export const writeAutoApplySmall = (value: boolean) => writeFlag(EDIT_AUTOAPPLY_STORAGE_KEY, value);
