import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TaskStatus } from '@workspace/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertMember(workspaceId: string, userId: string) {
    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!membership) {
      throw new ForbiddenException('Not a member of this workspace');
    }
  }

  private async assertMemberViaTask(taskId: string, userId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException('Task not found');
    }
    await this.assertMember(task.workspaceId, userId);
    return task;
  }

  async createTask(
    userId: string,
    workspaceId: string,
    title: string,
    description?: string,
    dueAt?: string,
    assigneeId?: string,
  ) {
    await this.assertMember(workspaceId, userId);
    return this.prisma.task.create({
      data: {
        workspaceId,
        title,
        description,
        dueAt: dueAt ? new Date(dueAt) : undefined,
        assigneeId,
        creatorId: userId,
      },
    });
  }

  async updateTaskStatus(userId: string, taskId: string, status: TaskStatus) {
    await this.assertMemberViaTask(taskId, userId);
    // Cast: Prisma's generated TaskStatus enum is structurally identical to
    // @workspace/shared's but a nominally distinct TS type - see the same
    // note in workspaces.service.ts for WorkspaceRole.
    return this.prisma.task.update({ where: { id: taskId }, data: { status: status as any } });
  }

  async assignTask(userId: string, taskId: string, assigneeId: string) {
    const task = await this.assertMemberViaTask(taskId, userId);
    // Assignee must also belong to the workspace.
    await this.assertMember(task.workspaceId, assigneeId);
    return this.prisma.task.update({ where: { id: taskId }, data: { assigneeId } });
  }

  async tasks(userId: string, workspaceId: string) {
    await this.assertMember(workspaceId, userId);
    return this.prisma.task.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
