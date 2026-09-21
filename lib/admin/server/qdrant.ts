import { QdrantClient } from '@qdrant/js-client-rest';
import {
  getQdrantConfig,
  type QdrantConfig,
} from '@/lib/admin/server/config';

export interface QdrantEvidenceAdapter {
  hasProcessedEvidence(sourceKey: string): Promise<boolean>;
}

type QdrantScroller = Pick<QdrantClient, 'scroll'>;

export class QdrantRestEvidenceAdapter implements QdrantEvidenceAdapter {
  constructor(
    private readonly client: QdrantScroller,
    private readonly collection: string,
  ) {}

  async hasProcessedEvidence(sourceKey: string): Promise<boolean> {
    const result = await this.client.scroll(this.collection, {
      filter: {
        must: [{ key: 'source_key', match: { value: sourceKey } }],
      },
      limit: 1,
      with_payload: false,
      with_vector: false,
    });
    return result.points.length > 0;
  }
}

export function createQdrantAdapter(
  config: QdrantConfig = getQdrantConfig(),
): QdrantEvidenceAdapter {
  return new QdrantRestEvidenceAdapter(
    new QdrantClient({ url: config.url, apiKey: config.apiKey }),
    config.collection,
  );
}
