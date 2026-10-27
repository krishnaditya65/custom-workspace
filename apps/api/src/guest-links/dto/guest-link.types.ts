import { Field, ID, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { GuestLinkPermission } from '@workspace/shared';
import { WorkspaceType } from '../../workspaces/dto/workspace.types';

registerEnumType(GuestLinkPermission, { name: 'GuestLinkPermission' });

@ObjectType()
export class GuestLinkType {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  workspaceId!: string;

  @Field()
  token!: string;

  @Field(() => GuestLinkPermission)
  permission!: GuestLinkPermission;

  @Field(() => Date, { nullable: true })
  expiresAt?: Date | null;

  @Field()
  createdAt!: Date;
}

@InputType()
export class CreateGuestLinkInput {
  @Field(() => ID)
  @IsString()
  workspaceId!: string;

  @Field(() => GuestLinkPermission)
  @IsEnum(GuestLinkPermission)
  permission!: GuestLinkPermission;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

@ObjectType()
export class ResolvedGuestLink {
  @Field(() => WorkspaceType)
  workspace!: WorkspaceType;

  @Field(() => GuestLinkPermission)
  permission!: GuestLinkPermission;

  /** Short-lived scoped JWT the guest client should attach as Authorization: Bearer. */
  @Field()
  accessToken!: string;
}
