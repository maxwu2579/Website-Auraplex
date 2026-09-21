'use client';

import { useMemo, useRef, useState, type DragEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Database,
  FileText,
  Film,
  Image as ImageIcon,
  LogOut,
  ShieldCheck,
  UploadCloud,
  X,
} from 'lucide-react';
import { Button } from '@/components/primitives/button';
import type { Category } from '@/lib/catalog';

const MAX_FILE_SIZE = 500 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = new Set([
  'pdf',
  'docx',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'mp4',
  'webm',
  'mov',
]);

const INPUT_ACCEPT = [
  '.pdf',
  '.docx',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.mp4',
  '.webm',
  '.mov',
].join(',');

type ProductOption = {
  id: string;
  name: string;
  slug: string;
  category: Category;
};

type QueuedFile = {
  id: string;
  file: File;
  extension: string;
  ingestion: 'supported' | 'deferred';
};

type Props = {
  products: ProductOption[];
};

function extensionOf(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function FileIcon({ extension }: { extension: string }) {
  const className = 'h-5 w-5 text-[color:var(--color-signal)]';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(extension)) {
    return <ImageIcon aria-hidden="true" className={className} />;
  }
  if (['mp4', 'webm', 'mov'].includes(extension)) {
    return <Film aria-hidden="true" className={className} />;
  }
  return <FileText aria-hidden="true" className={className} />;
}

function newFileId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function UploadPanel({ products }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [productLine, setProductLine] = useState<Category | ''>('');
  const [productId, setProductId] = useState('');
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const filteredProducts = useMemo(
    () => products.filter((product) => product.category === productLine),
    [productLine, products],
  );

  const selectedProduct = products.find((product) => product.id === productId);
  const canPrepareUpload = Boolean(productLine && productId && files.length > 0);

  function changeProductLine(value: Category | '') {
    setProductLine(value);
    setProductId('');
  }

  function addFiles(incoming: FileList | File[]) {
    const accepted: QueuedFile[] = [];
    const rejected: string[] = [];

    for (const file of Array.from(incoming)) {
      const extension = extensionOf(file.name);
      if (!ACCEPTED_EXTENSIONS.has(extension)) {
        rejected.push(`${file.name}: unsupported file type`);
        continue;
      }
      if (file.size === 0) {
        rejected.push(`${file.name}: empty file`);
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        rejected.push(`${file.name}: exceeds 500 MB`);
        continue;
      }

      accepted.push({
        id: newFileId(),
        file,
        extension,
        ingestion: extension === 'pdf' ? 'supported' : 'deferred',
      });
    }

    setFiles((current) => {
      const known = new Set(current.map(({ file }) => `${file.name}:${file.size}:${file.lastModified}`));
      return [
        ...current,
        ...accepted.filter(({ file }) => !known.has(`${file.name}:${file.size}:${file.lastModified}`)),
      ];
    });
    setNotice(rejected.length > 0 ? rejected.join('. ') : null);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    addFiles(event.dataTransfer.files);
  }

  function removeFile(id: string) {
    setFiles((current) => current.filter((item) => item.id !== id));
  }

  return (
    <div className="min-h-screen bg-[color:var(--color-ink)]">
      <header className="border-b border-[color:var(--color-neutral-700)] bg-[color:var(--color-neutral-800)]/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-6 px-5 py-4 sm:px-8 lg:px-12">
          <div className="flex min-w-0 items-center gap-4">
            <div className="grid h-10 w-10 shrink-0 place-items-center border border-[color:var(--color-signal)] text-[color:var(--color-signal)]">
              <Database aria-hidden="true" className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate font-display text-xl font-semibold">Auraplex Admin</p>
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-neutral-400)]">
                Knowledge base operations
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="font-mono text-xs uppercase tracking-wider">Authentication pending</p>
              <p className="text-xs text-[color:var(--color-neutral-400)]">Keycloak will supply the user</p>
            </div>
            <button
              type="button"
              disabled
              aria-label="Sign out will be available after authentication is connected"
              className="grid h-10 w-10 place-items-center border border-[color:var(--color-neutral-700)] text-[color:var(--color-neutral-400)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <LogOut aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-[1500px] px-5 py-10 sm:px-8 lg:px-12 lg:py-14">
        <div className="mb-10 flex flex-col justify-between gap-5 border-b border-[color:var(--color-neutral-700)] pb-8 lg:flex-row lg:items-end">
          <div>
            <div className="mb-4 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-signal)]">
              <ShieldCheck aria-hidden="true" className="h-4 w-4" />
              Restricted workspace
            </div>
            <h1 className="max-w-4xl font-display text-4xl font-semibold leading-[1.05] sm:text-5xl lg:text-6xl">
              Upload source material
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-[color:var(--color-neutral-300)] sm:text-base">
              Attach product metadata, queue source files, and track ingestion without direct MinIO access.
            </p>
          </div>
          <div className="flex items-center gap-3 border border-[color:var(--color-warning)]/50 bg-[color:var(--color-warning)]/10 px-4 py-3 text-sm text-[color:var(--color-warning)]">
            <Clock3 aria-hidden="true" className="h-4 w-4 shrink-0" />
            UI scaffold — backend connection pending
          </div>
        </div>

        <div className="grid gap-8 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.75fr)]">
          <section aria-labelledby="upload-heading" className="border border-[color:var(--color-neutral-700)] bg-[color:var(--color-neutral-800)]/55">
            <div className="flex items-center justify-between border-b border-[color:var(--color-neutral-700)] px-5 py-4 sm:px-6">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--color-signal)]">Step 01</p>
                <h2 id="upload-heading" className="mt-1 font-display text-2xl font-semibold">Prepare upload</h2>
              </div>
              <span className="font-mono text-xs text-[color:var(--color-neutral-400)]">500 MB max / file</span>
            </div>

            <div className="space-y-7 p-5 sm:p-6">
              <div className="grid gap-5 md:grid-cols-2">
                <label className="block">
                  <span className="mb-2 block font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--color-neutral-300)]">
                    Product line <span className="text-[color:var(--color-signal)]">*</span>
                  </span>
                  <select
                    value={productLine}
                    onChange={(event) => changeProductLine(event.target.value as Category | '')}
                    className="h-12 w-full border border-[color:var(--color-neutral-600)] bg-[color:var(--color-ink)] px-4 text-sm outline-none transition-colors focus:border-[color:var(--color-signal)]"
                  >
                    <option value="">Select a product line</option>
                    <option value="labelling">Labelling</option>
                    <option value="packaging">Packaging</option>
                    <option value="automation">Automation</option>
                  </select>
                </label>

                <label className="block">
                  <span className="mb-2 block font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--color-neutral-300)]">
                    Product <span className="text-[color:var(--color-signal)]">*</span>
                  </span>
                  <select
                    value={productId}
                    onChange={(event) => setProductId(event.target.value)}
                    disabled={!productLine}
                    className="h-12 w-full border border-[color:var(--color-neutral-600)] bg-[color:var(--color-ink)] px-4 text-sm outline-none transition-colors focus:border-[color:var(--color-signal)] disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <option value="">{productLine ? 'Select a product' : 'Select a product line first'}</option>
                    {filteredProducts.map((product) => (
                      <option key={product.id} value={product.id}>{product.name}</option>
                    ))}
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

              <div
                onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => {
                  if (event.currentTarget === event.target) setDragActive(false);
                }}
                onDrop={handleDrop}
                className={`relative grid min-h-64 place-items-center border border-dashed px-6 py-10 text-center transition-colors ${
                  dragActive
                    ? 'border-[color:var(--color-signal)] bg-[color:var(--color-signal)]/10'
                    : 'border-[color:var(--color-neutral-600)] bg-[color:var(--color-ink)]/45 hover:border-[color:var(--color-neutral-400)]'
                }`}
              >
                <div>
                  <div className="mx-auto grid h-14 w-14 place-items-center border border-[color:var(--color-signal)]/60 text-[color:var(--color-signal)]">
                    <UploadCloud aria-hidden="true" className="h-6 w-6" />
                  </div>
                  <p className="mt-5 font-display text-2xl font-semibold">Drop source files here</p>
                  <p className="mt-2 text-sm text-[color:var(--color-neutral-400)]">
                    PDF, DOCX, PNG, JPG, WebP, MP4, WebM or QuickTime
                  </p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-5 font-mono text-xs uppercase tracking-[0.16em] text-[color:var(--color-signal)] underline decoration-[color:var(--color-signal)]/50 underline-offset-4 hover:text-[color:var(--color-signal-bright)]"
                  >
                    Browse files
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={INPUT_ACCEPT}
                    className="sr-only"
                    onChange={(event) => {
                      if (event.target.files) addFiles(event.target.files);
                      event.target.value = '';
                    }}
                  />
                </div>
              </div>

              {notice && (
                <div role="alert" className="flex gap-3 border border-[color:var(--color-danger)]/50 bg-[color:var(--color-danger)]/10 p-4 text-sm text-[color:var(--color-danger)]">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{notice}</span>
                </div>
              )}

              {files.length > 0 && (
                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="font-mono text-xs uppercase tracking-[0.16em]">Files ready</h3>
                    <button
                      type="button"
                      onClick={() => setFiles([])}
                      className="text-xs text-[color:var(--color-neutral-400)] hover:text-[color:var(--color-paper)]"
                    >
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
                              {item.ingestion === 'supported' ? 'Indexable' : 'Storage only'}
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeFile(item.id)}
                          aria-label={`Remove ${item.file.name}`}
                          className="grid h-9 w-9 shrink-0 place-items-center text-[color:var(--color-neutral-400)] hover:bg-[color:var(--color-danger)]/10 hover:text-[color:var(--color-danger)]"
                        >
                          <X aria-hidden="true" className="h-4 w-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-col gap-3 border-t border-[color:var(--color-neutral-700)] pt-6 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-5 text-[color:var(--color-neutral-400)]">
                  Server-side authentication, MIME sniffing and streaming limits will be added with the upload endpoint.
                </p>
                <Button
                  type="button"
                  disabled={!canPrepareUpload}
                  onClick={() => setNotice('Upload API connection is not configured on this scaffold branch yet.')}
                  className="shrink-0"
                >
                  Upload {files.length || ''} file{files.length === 1 ? '' : 's'}
                  <ChevronRight aria-hidden="true" className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </section>

          <aside aria-labelledby="status-heading" className="border border-[color:var(--color-neutral-700)] bg-[color:var(--color-neutral-800)]/55">
            <div className="border-b border-[color:var(--color-neutral-700)] px-5 py-4 sm:px-6">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--color-signal)]">Step 02</p>
              <h2 id="status-heading" className="mt-1 font-display text-2xl font-semibold">Recent uploads</h2>
            </div>

            <div className="p-5 sm:p-6">
              <div className="grid min-h-52 place-items-center border border-[color:var(--color-neutral-700)] bg-[color:var(--color-ink)]/35 px-5 text-center">
                <div>
                  <CheckCircle2 aria-hidden="true" className="mx-auto h-7 w-7 text-[color:var(--color-neutral-500)]" />
                  <p className="mt-4 text-sm text-[color:var(--color-neutral-200)]">No uploads to display</p>
                  <p className="mt-2 text-xs leading-5 text-[color:var(--color-neutral-400)]">
                    MinIO and Qdrant status will appear here after the backend connection is configured.
                  </p>
                </div>
              </div>

              <div className="mt-6 space-y-3">
                {[
                  ['Queued', 'Stored, ingestion support pending', 'var(--color-warning)'],
                  ['Pending', 'Stored and waiting for ingest evidence', 'var(--color-info)'],
                  ['Processed', 'Qdrant source key confirmed', 'var(--color-success)'],
                  ['Failed', 'Confirmed failure signal received', 'var(--color-danger)'],
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
        </div>
      </main>
    </div>
  );
}
