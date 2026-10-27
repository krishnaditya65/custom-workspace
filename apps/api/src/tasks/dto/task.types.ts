import { Field, ID, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsDateString, IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { TaskStatus } from '@workspace/shared';

registerEnumType(TaskStatus, { name: 'TaskStatus' });

@ObjectType()
export class TaskType {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  workspaceId!: string;

  @Field()
  title!: string;

  @Field(() => String, { nullable: true })
  description?: string | null;

  @Field(() => TaskStatus)
  status!: TaskStatus;

  @Field(() => Date, { nullable: true })
  dueAt?: Date | null;

  @Field(() => ID, { nullable: true })
  assigneeId?: string | null;

  @Field(() => ID)
  creatorId!: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

@InputType()
export class CreateTaskInput {
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

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsDateString()
  dueAt?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  assigneeId?: string;
}

@InputType()
export class UpdateTaskStatusInput {
  @Field(() => ID)
  @IsString()
  taskId!: string;

  @Field(() => TaskStatus)
  @IsEnum(TaskStatus)
  status!: TaskStatus;
}

@InputType()
export class AssignTaskInput {
  @Field(() => ID)
  @IsString()
  taskId!: string;

  @Field(() => ID)
  @IsString()
  assigneeId!: string;
}
