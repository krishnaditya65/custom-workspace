import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { TasksService } from './tasks.service';
import { AssignTaskInput, CreateTaskInput, TaskType, UpdateTaskStatusInput } from './dto/task.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/decorators/current-user.decorator';

@Resolver(() => TaskType)
@UseGuards(JwtAuthGuard)
export class TasksResolver {
  constructor(private readonly tasksService: TasksService) {}

  @Mutation(() => TaskType)
  async createTask(@Args('input') input: CreateTaskInput, @CurrentUser() caller: RequestUser): Promise<TaskType> {
    return this.tasksService.createTask(
      caller.userId,
      input.workspaceId,
      input.title,
      input.description,
      input.dueAt,
      input.assigneeId,
    ) as unknown as Promise<TaskType>;
  }

  @Mutation(() => TaskType)
  async updateTaskStatus(
    @Args('input') input: UpdateTaskStatusInput,
    @CurrentUser() caller: RequestUser,
  ): Promise<TaskType> {
    return this.tasksService.updateTaskStatus(
      caller.userId,
      input.taskId,
      input.status,
    ) as unknown as Promise<TaskType>;
  }

  @Mutation(() => TaskType)
  async assignTask(@Args('input') input: AssignTaskInput, @CurrentUser() caller: RequestUser): Promise<TaskType> {
    return this.tasksService.assignTask(
      caller.userId,
      input.taskId,
      input.assigneeId,
    ) as unknown as Promise<TaskType>;
  }

  @Query(() => [TaskType])
  async tasks(
    @Args('workspaceId', { type: () => ID }) workspaceId: string,
    @CurrentUser() caller: RequestUser,
  ): Promise<TaskType[]> {
    return this.tasksService.tasks(caller.userId, workspaceId) as unknown as Promise<TaskType[]>;
  }
}
