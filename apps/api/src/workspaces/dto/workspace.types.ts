import { Field, ID, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsEmail, IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { WorkspaceRole } from '@workspace/shared';
import { UserType } from '../../auth/dto/auth.types';

registerEnumType(WorkspaceRole, { name: 'WorkspaceRole' });

@ObjectType()
export class WorkspaceMemberType {
  @Field(() => ID)
  id!: string;

  @Field(() => UserType)
  user!: UserType;

  @Field(() => WorkspaceRole)
  role!: WorkspaceRole;

  @Field()
  joinedAt!: Date;
}

@ObjectType()
export class WorkspaceType {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  slug!: string;

  @Field()
  createdAt!: Date;

  @Field(() => [WorkspaceMemberType], { nullable: true })
  members?: WorkspaceMemberType[];
}

@InputType()
export class CreateWorkspaceInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  name!: string;
}

@InputType()
export class InviteMemberInput {
  @Field(() => ID)
  @IsString()
  workspaceId!: string;

  @Field()
  @IsEmail()
  email!: string;

  @Field(() => WorkspaceRole)
  @IsEnum(WorkspaceRole)
  role!: WorkspaceRole;
}
