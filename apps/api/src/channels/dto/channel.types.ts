import { Field, ID, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ChannelKind } from '@workspace/shared';

registerEnumType(ChannelKind, { name: 'ChannelKind' });

@ObjectType()
export class ChannelType {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  workspaceId!: string;

  @Field()
  name!: string;

  @Field(() => ChannelKind)
  kind!: ChannelKind;

  @Field()
  isPrivate!: boolean;

  @Field(() => ID, { nullable: true })
  parentId?: string | null;

  @Field()
  createdAt!: Date;

  /**
   * Derived, not a real column: schema.prisma's Channel model has no
   * archivedAt/deletedAt field (and this generator must not modify the
   * schema). ChannelsService encodes "archived" as an `[archived] ` name
   * prefix convention (see archiveChannel) and this resolver-computed field
   * simply reports whether that marker is present, so GraphQL consumers get
   * a clean boolean without caring about the underlying encoding. TODO: once
   * a migration can be authored, replace this with a real `archivedAt
   * DateTime?` column and drop the name-prefix hack.
   */
  @Field()
  isArchived!: boolean;

  @Field(() => [ChannelType], { nullable: true })
  children?: ChannelType[];
}

@InputType()
export class CreateChannelInput {
  @Field(() => ID)
  @IsString()
  workspaceId!: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  name!: string;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  @IsBoolean()
  isPrivate?: boolean;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  parentId?: string;
}
