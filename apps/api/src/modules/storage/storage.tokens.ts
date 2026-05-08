/**
 * DI tokens for the storage module. Kept in a leaf file to avoid the same
 * circular-import trap that bit the database module.
 */
export const S3_INTERNAL = Symbol("CMC_S3_INTERNAL");
export const S3_PUBLIC = Symbol("CMC_S3_PUBLIC");
