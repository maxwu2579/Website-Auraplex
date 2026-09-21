import { UploadPanel } from '@/components/admin/upload-panel';
import { MACHINES } from '@/lib/catalog';

export default function AdminUploadPage() {
  const products = MACHINES.map(({ id, name, slug, category }) => ({
    id,
    name,
    slug,
    category,
  }));

  return <UploadPanel products={products} />;
}
