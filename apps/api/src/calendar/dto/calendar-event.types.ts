import { Field, ID, InputType, ObjectType } from '@nestjs/graphql';
import { IsDateString, IsNotEmpty, IsOptional, IsString } from 'class-validator';

@ObjectType()
export class CalendarEventType {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  workspaceId!: string;

  @Field()
  title!: string;

  @Field(() => String, { nullable: true })
  description?: string | null;

  @Field()
  startsAt!: Date;

  @Field()
  endsAt!: Date;

  @Field(() => ID)
  organizerId!: string;

  @Field()
  createdAt!: Date;
}

@InputType()
export class CreateEventInput {
  @Field(() => ID)
  @IsString()
  workspaceId!: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  title!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field()
  @IsDateString()
  startsAt!: string;

  @Field()
  @IsDateString()
  endsAt!: string;
}
