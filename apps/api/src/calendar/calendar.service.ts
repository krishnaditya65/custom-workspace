import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CalendarService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertMember(workspaceId: string, userId: string) {
    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!membership) {
      throw new ForbiddenException('Not a member of this workspace');
    }
  }

  async createEvent(
    userId: string,
    workspaceId: string,
    title: string,
    startsAt: string,
    endsAt: string,
    description?: string,
  ) {
    await this.assertMember(workspaceId, userId);
    return this.prisma.calendarEvent.create({
      data: {
        workspaceId,
        title,
        description,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        organizerId: userId,
      },
    });
  }

  async events(userId: string, workspaceId: string, from?: string, to?: string) {
    await this.assertMember(workspaceId, userId);
    return this.prisma.calendarEvent.findMany({
      where: {
        workspaceId,
        ...(from ? { startsAt: { gte: new Date(from) } } : {}),
        ...(to ? { endsAt: { lte: new Date(to) } } : {}),
      },
      orderBy: { startsAt: 'asc' },
    });
  }
}
