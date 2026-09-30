// Hands a file dropped on the Landing page to the Upload screen (same tab, in-app navigation).
let pending: File | null = null;

export function setPendingUpload(file: File): void {
  pending = file;
}

/** The waiting file, once: a second call returns null. */
export function takePendingUpload(): File | null {
  const file = pending;
  pending = null;
  return file;
}
