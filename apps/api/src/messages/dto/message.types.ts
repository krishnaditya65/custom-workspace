import { Field, ID, Int, InputType, ObjectType } from '@nestjs/graphql';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { UserType } from '../../auth/dto/auth.types';

@ObjectType()
export class MessageType {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  channelId!: string;

  @Field(() => UserType, { nullable: true })
  author?: UserType;

  @Field()
  body!: string;

  @Field(() => ID, { nullable: true })
  threadRootId?: string | null;

  @Field(() => Int)
  replyCount!: number;

  @Field(() => Date, { nullable: true })
  editedAt?: Date | null;

  @Field(() => Date, { nullable: true })
  deletedAt?: Date | null;

  @Field()
  createdAt!: Date;
}

@ObjectType()
export class MessagePage {
  @Field(() => [MessageType])
  items!: MessageType[];

  @Field(() => ID, { nullable: true })
  nextCursor?: string | null;

  @Field()
  hasMore!: boolean;
}

@InputType()
export class SendMessageInput {
  @Field(() => ID)
  @IsString()
  channelId!: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  body!: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  threadRootId?: string;
}

@InputType()
export class EditMessageInput {
  @Field(() => ID)
  @IsString()
  messageId!: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  body!: string;
}

@InputType()
export class MessagesQueryInput {
  @Field(() => ID)
  @IsString()
  channelId!: string;

  /** Opaque cursor - the id of the oldest message already fetched. */
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  cursor?: string;

  @Field(() => Int, { nullable: true, defaultValue: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
