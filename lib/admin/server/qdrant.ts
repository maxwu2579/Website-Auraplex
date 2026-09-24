import { QdrantClient } from '@qdrant/js-client-rest';
import {
  getQdrantConfig,
  type QdrantConfig,
} from '@/lib/admin/server/config';

export interface QdrantEvidenceAdapter {
  hasProcessedEvidence(sourceKey: string): Promise<boolean>;
  deleteBySourceKey(sourceKey: string): Promise<void>;
}

type QdrantScroller = Pick<QdrantClient, 'scroll' | 'delete'>;
export type QdrantCollectionResolver = (sourceKey: string) => string;

// Current compatibility behavior only. The confirmed per-line collection
// mapping can replace this resolver without changing status/delete callers.
export function currentCollectionResolver(collection: string): QdrantCollectionResolver {
  return () => collection;
}

export class QdrantRestEvidenceAdapter implements QdrantEvidenceAdapter {
  constructor(
    private readonly client: QdrantScroller,
    collection: string | QdrantCollectionResolver,
  ) {
    this.collectionForSourceKey = typeof collection === 'string'
      ? currentCollectionResolver(collection)
      : collection;
  }

  private readonly collectionForSourceKey: QdrantCollectionResolver;

  async hasProcessedEvidence(sourceKey: string): Promise<boolean> {
    const result = await this.client.scroll(this.collectionForSourceKey(sourceKey), {
      filter: {
        must: [{ key: 'source_key', match: { value: sourceKey } }],
      },
      limit: 1,
      with_payload: false,
      with_vector: false,
    });
    return result.points.length > 0;
  }

  async deleteBySourceKey(sourceKey: string): Promise<void> {
    const result = await this.client.delete(this.collectionForSourceKey(sourceKey), {
      filter: { must: [{ key: 'source_key', match: { value: sourceKey } }] },
      wait: true,
    });
    if (result.status !== 'completed') {
      throw new Error('Qdrant deletion has not completed');
    }
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
