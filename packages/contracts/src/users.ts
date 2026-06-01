import { z } from "zod";

/**
 * Admin user-management contracts (P1.4b / ADR-0022).
 *
 * Backs `/admin/users` and the `GET/POST/PATCH/DELETE /users` API. A created
 * user is **passwordless** (can't log in) until an admin triggers a password
 * reset (P1.3) — there's no email channel yet, so the admin relays the token.
 */

/** A role reference as shown on a user (lighter than the full RoleResponse). */
export const UserRoleRefSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
});
export type UserRoleRef = z.infer<typeof UserRoleRefSchema>;

export const UserSummarySchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  isActive: z.boolean(),
  /** False until a password is set (e.g. a freshly-invited user). */
  hasPassword: z.boolean(),
  lastLoginAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  roles: z.array(UserRoleRefSchema),
});
export type UserSummary = z.infer<typeof UserSummarySchema>;

export const UsersListResponseSchema = z.object({
  users: z.array(UserSummarySchema),
});
export type UsersListResponse = z.infer<typeof UsersListResponseSchema>;

export const UserDetailResponseSchema = z.object({
  user: UserSummarySchema,
});
export type UserDetailResponse = z.infer<typeof UserDetailResponseSchema>;

export const CreateUserRequestSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().trim().min(1).max(200),
  /** Optional system/custom role slugs to grant at creation. */
  roleSlugs: z.array(z.string()).optional(),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export const UpdateUserRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.isActive !== undefined, {
    message: "Provide at least one of name or isActive",
  });
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;
