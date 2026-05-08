/**
 * DI tokens for the database module. Kept in a leaf file so providers and
 * consumers can both reference them without creating a circular import
 * with database.module.ts (which itself imports the providers).
 */
export const DB = Symbol("CMC_DB");
