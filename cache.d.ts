import { CacheManager } from "hcacher";
export interface MetadataCacheOptions {
    ttl?: number;
    maxSize?: number;
}
/** Bounded TTL cache for metadata only; never stores live media or session keys. */
export declare function createMetadataCache<T>(options?: MetadataCacheOptions): CacheManager<T>;
//# sourceMappingURL=cache.d.ts.map