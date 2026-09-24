'use client';

import { CheckCircle2, FileText, Film, Image as ImageIcon, UploadCloud, X } from 'lucide-react';
import type { DragEvent, RefObject } from 'react';
import type { Category } from '@/lib/catalog';
import { UPLOAD_INPUT_ACCEPT, type RecentUpload, type UiUploadQueueStatus } from '@/lib/admin/upload-contract';

export type ProductOption = {
  id: string;
  name: string;
  slug: string;
  category: Category;
};

export type QueuedFile = {
  id: string;
  file: File;
  extension: string;
  ingestion: 'supported' | 'deferred';
  status: UiUploadQueueStatus;
  error?: string;
};

export function ProductSelector({ productLine, productId, productLines, filteredProducts, selectedProduct, onProductLineChange, onProductChange }: {
  productLine: Category | '';
  productId: string;
  productLines: Category[];
  filteredProducts: ProductOption[];
  selectedProduct?: ProductOption;
  onProductLineChange: (line: Category | '') => void;
  onProductChange: (id: string) => void;
}) {
  return (
    <>
      <div className="grid gap-5 md:grid-cols-2">
        <label className="block">
          <span className="mb-2 block font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--color-neutral-300)]">
            Product line <span className="text-[color:var(--color-signal)]">*</span>
          </span>
          <select value={productLine} onChange={(event) => onProductLineChange(event.target.value as Category | '')} className="h-12 w-full border border-[color:var(--color-neutral-600)] bg-[color:var(--color-ink)] px-4 text-sm outline-none transition-colors focus:border-[color:var(--color-signal)]">
            <option value="">Select a product line</option>
            {productLines.map((line) => <option key={line} value={line}>{line.charAt(0).toUpperCase() + line.slice(1)}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-2 block font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--color-neutral-300)]">
            Product <span className="text-[color:var(--color-signal)]">*</span>
          </span>
          <select value={productId} onChange={(event) => onProductChange(event.target.value)} disabled={!productLine} className="h-12 w-full border border-[color:var(--color-neutral-600)] bg-[color:var(--color-ink)] px-4 text-sm outline-none transition-colors focus:border-[color:var(--color-signal)] disabled:cursor-not-allowed disabled:opacity-45">
            <option value="">{productLine ? 'Select a product' : 'Select a product line first'}</option>
            {filteredProducts.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
          </select>
        </label>
      </div>
      {selectedProduct && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-[color:var(--color-signal)] pl-4 text-sm text-[color:var(--color-neutral-300)]">
          <span className="text-[color:var(--color-paper)]">{selectedProduct.name}</span>
          <span className="font-mono text-xs">ID {selectedProduct.id}</span>
          <span className="font-mono text-xs">/{selectedProduct.slug}</span>
        </div>
      )}
    </>
  );
}

export function FileDropzone({ fileInputRef, dragActive, onDragActiveChange, onDrop, onFiles }: {
  fileInputRef: RefObject<HTMLInputElement | null>;
  dragActive: boolean;
  onDragActiveChange: (active: boolean) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onFiles: (files: FileList) => void;
}) {
  return (
    <div
      onDragEnter={(event) => { event.preventDefault(); onDragActiveChange(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.currentTarget === event.target) onDragActiveChange(false); }}
      onDrop={onDrop}
      className={`relative grid min-h-64 place-items-center border border-dashed px-6 py-10 text-center transition-colors ${dragActive
        ? 'border-[color:var(--color-signal)] bg-[color:var(--color-signal)]/10'
        : 'border-[color:var(--color-neutral-600)] bg-[color:var(--color-ink)]/45 hover:border-[color:var(--color-neutral-400)]'}`}
    >
      <div>
        <div className="mx-auto grid h-14 w-14 place-items-center border border-[color:var(--color-signal)]/60 text-[color:var(--color-signal)]">
          <UploadCloud aria-hidden="true" className="h-6 w-6" />
        </div>
        <p className="mt-5 font-display text-2xl font-semibold">Drop source files here</p>
        <p className="mt-2 text-sm text-[color:var(--color-neutral-400)]">PDF, DOCX, PNG, JPG or MP4</p>
        <button type="button" onClick={() => fileInputRef.current?.click()} className="mt-5 font-mono text-xs uppercase tracking-[0.16em] text-[color:var(--color-signal)] underline decoration-[color:var(--color-signal)]/50 underline-offset-4 hover:text-[color:var(--color-signal-bright)]">
          Browse files
        </button>
        <input ref={fileInputRef} type="file" multiple accept={UPLOAD_INPUT_ACCEPT} className="sr-only" onChange={(event) => {
          if (event.target.files) onFiles(event.target.files);
          event.target.value = '';
        }} />
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function FileIcon({ extension }: { extension: string }) {
  const className = 'h-5 w-5 text-[color:var(--color-signal)]';
  if (['png', 'jpg', 'jpeg'].includes(extension)) {
    return <ImageIcon aria-hidden="true" className={className} />;
  }
  if (extension === 'mp4') {
    return <Film aria-hidden="true" className={className} />;
  }
  return <FileText aria-hidden="true" className={className} />;
}

export function UploadQueue({ files, uploading, onClear, onRetry, onRemove }: {
  files: QueuedFile[];
  uploading: boolean;
  onClear: () => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-mono text-xs uppercase tracking-[0.16em]">Files ready</h3>
        <button type="button" onClick={onClear} className="text-xs text-[color:var(--color-neutral-400)] hover:text-[color:var(--color-paper)]">
          Clear all
        </button>
      </div>
      <ul className="divide-y divide-[color:var(--color-neutral-700)] border border-[color:var(--color-neutral-700)]">
        {files.map((item) => (
          <li key={item.id} className="flex items-center gap-4 px-4 py-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center bg-[color:var(--color-ink)]">
              <FileIcon extension={item.extension} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-[color:var(--color-paper)]">{item.file.name}</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-wider text-[color:var(--color-neutral-400)]">
                <span>{formatBytes(item.file.size)}</span>
                <span>{item.extension}</span>
                <span className={item.ingestion === 'supported' ? 'text-[color:var(--color-success)]' : 'text-[color:var(--color-warning)]'}>
                  {item.ingestion === 'supported' ? 'Indexable' : 'Ingestion support coming'}
                </span>
                <span>{item.status}</span>
              </div>
              {item.error && <p className="mt-1 text-xs text-[color:var(--color-danger)]">{item.error}</p>}
            </div>
            {item.status === 'failed' && (
              <button type="button" disabled={uploading} onClick={() => onRetry(item.id)} className="font-mono text-[10px] uppercase tracking-wider text-[color:var(--color-signal)]">
                Retry
              </button>
            )}
            <button type="button" onClick={() => onRemove(item.id)} aria-label={`Remove ${item.file.name}`} className="grid h-9 w-9 shrink-0 place-items-center text-[color:var(--color-neutral-400)] hover:bg-[color:var(--color-danger)]/10 hover:text-[color:var(--color-danger)]">
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RecentUploadsPanel({ uploads, notice, canDelete, deletingKey, onDelete }: {
  uploads: RecentUpload[];
  notice: string;
  canDelete: boolean;
  deletingKey: string | null;
  onDelete: (upload: RecentUpload) => void;
}) {
  return (
    <aside aria-labelledby="status-heading" className="border border-[color:var(--color-neutral-700)] bg-[color:var(--color-neutral-800)]/55">
      <div className="border-b border-[color:var(--color-neutral-700)] px-5 py-4 sm:px-6">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--color-signal)]">Step 02</p>
        <h2 id="status-heading" className="mt-1 font-display text-2xl font-semibold">Recent uploads</h2>
      </div>
      <div className="p-5 sm:p-6">
        {uploads.length === 0 ? (
          <div className="grid min-h-52 place-items-center border border-[color:var(--color-neutral-700)] bg-[color:var(--color-ink)]/35 px-5 text-center">
            <div>
              <CheckCircle2 aria-hidden="true" className="mx-auto h-7 w-7 text-[color:var(--color-neutral-500)]" />
              <p className="mt-4 text-sm text-[color:var(--color-neutral-200)]">No uploads to display</p>
              <p className="mt-2 text-xs leading-5 text-[color:var(--color-neutral-400)]">{notice}</p>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-[color:var(--color-neutral-700)] border border-[color:var(--color-neutral-700)]">
            {uploads.map((upload) => (
              <li key={`${upload.bucket}/${upload.key}`} className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate text-sm">{upload.filename}</p>
                  <span className="font-mono text-[10px] uppercase text-[color:var(--color-signal)]">{upload.status}</span>
                </div>
                {upload.ingestionCapability === 'deferred' && <p className="mt-1 text-xs text-[color:var(--color-warning)]">Ingestion support coming</p>}
                <p className="mt-2 truncate font-mono text-[10px] text-[color:var(--color-neutral-400)]">{upload.sourceKey}</p>
                {canDelete && <button type="button" disabled={deletingKey === `${upload.bucket}/${upload.key}`} onClick={() => onDelete(upload)} className="mt-2 text-xs text-[color:var(--color-danger)] disabled:opacity-50">{deletingKey === `${upload.bucket}/${upload.key}` ? 'Deleting…' : 'Delete'}</button>}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-6 space-y-3">
          {[
            ['Pending', 'Stored; PDF awaits processing, other formats await ingestion support', 'var(--color-info)'],
            ['Processed', 'Qdrant source key confirmed', 'var(--color-success)'],
            ['Failed', 'Confirmed failure signal received', 'var(--color-danger)'],
            ['Unsupported', 'File type is not accepted', 'var(--color-warning)'],
          ].map(([label, description, color]) => (
            <div key={label} className="flex gap-3 text-xs">
              <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
              <div>
                <span className="font-mono uppercase tracking-wider text-[color:var(--color-neutral-200)]">{label}</span>
                <p className="mt-1 leading-5 text-[color:var(--color-neutral-400)]">{description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
