import { useState } from 'preact/hooks';

import { uploadPhoto } from '../api/client.js';

/**
 * Multi-file drag-drop uploader. Uploads sequentially to keep the
 * server's RAM bounded — individuals API caps a single photo at 20 MB,
 * but ten parallel uploads would defeat that.
 *
 * Calls `onUploaded(filename)` after each successful upload so the
 * parent can refresh its view between photos.
 */
export function PhotoUploader({
  individualName,
  onUploaded,
  onError,
}: {
  readonly individualName: string;
  readonly onUploaded: (filename: string) => void;
  readonly onError: (message: string) => void;
}): preact.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>(undefined);

  const handleFiles = async (fileList: FileList | null): Promise<void> => {
    if (fileList === null || fileList.length === 0) return;
    const files = Array.from(fileList);
    setBusy(true);
    setProgress({ done: 0, total: files.length });
    try {
      for (let i = 0; i < files.length; i += 1) {
        const f = files[i]!;
        try {
          const r = await uploadPhoto(individualName, f);
          onUploaded(r.filename);
        } catch (err: unknown) {
          onError(err instanceof Error ? err.message : String(err));
          return;
        }
        setProgress({ done: i + 1, total: files.length });
      }
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  };

  return (
    <div
      class={`photo-uploader${busy ? ' photo-uploader-busy' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        void handleFiles(e.dataTransfer?.files ?? null);
      }}
    >
      <label class="photo-uploader-label">
        <span>
          {busy && progress
            ? `Uploading ${progress.done}/${progress.total}…`
            : 'Drag photos here, or click to select'}
        </span>
        <input
          type="file"
          multiple
          accept="image/jpeg,image/png"
          disabled={busy}
          onChange={(e) => {
            void handleFiles((e.currentTarget as HTMLInputElement).files);
            (e.currentTarget as HTMLInputElement).value = '';
          }}
        />
      </label>
    </div>
  );
}
