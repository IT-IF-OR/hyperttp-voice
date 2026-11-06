"use strict";import{CacheManager as a}from"hcacher";export function createMetadataCache(r={}){const e=r.ttl??6e4,t=r.maxSize??128;if(!Number.isFinite(e)||e<=0)throw new RangeError("ttl must be finite and positive");if(!Number.isSafeInteger(t)||t<=0)throw new RangeError("maxSize must be a positive safe integer");return new a({ttl:e,maxSize:t,touchOnGet:!0})}
//# sourceMappingURL=cache.js.map
