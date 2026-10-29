import { CacheManager } from "hcacher";

export interface MetadataCacheOptions {
  ttl?: number;
  maxSize?: number;
}

/** Bounded TTL cache for metadata only; never stores live media or session keys. */
export function createMetadataCache<T>(options: MetadataCacheOptions = {}): CacheManager<T> {
  const ttl = options.ttl ?? 60_000;
  const maxSize = options.maxSize ?? 128;
  if (!Number.isFinite(ttl) || ttl <= 0) throw new RangeError("ttl must be finite and positive");
  if (!Number.isSafeInteger(maxSize) || maxSize <= 0)
    throw new RangeError("maxSize must be a positive safe integer");
  return new CacheManager<T>({ ttl, maxSize, touchOnGet: true });
}
