import { IsUUID } from "class-validator";

export class AssignRoleDto {
  @IsUUID(undefined, { message: "roleId must be a UUID" })
  roleId!: string;
}
