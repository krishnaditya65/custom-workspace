import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { CalendarService } from './calendar.service';
import { CalendarEventType, CreateEventInput } from './dto/calendar-event.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/decorators/current-user.decorator';

@Resolver(() => CalendarEventType)
@UseGuards(JwtAuthGuard)
export class CalendarResolver {
  constructor(private readonly calendarService: CalendarService) {}

  @Mutation(() => CalendarEventType)
  async createEvent(
    @Args('input') input: CreateEventInput,
    @CurrentUser() caller: RequestUser,
  ): Promise<CalendarEventType> {
    return this.calendarService.createEvent(
      caller.userId,
      input.workspaceId,
      input.title,
      input.startsAt,
      input.endsAt,
      input.description,
    ) as unknown as Promise<CalendarEventType>;
  }

  @Query(() => [CalendarEventType])
  async events(
    @Args('workspaceId', { type: () => ID }) workspaceId: string,
    @Args('from', { type: () => String, nullable: true }) from: string | undefined,
    @Args('to', { type: () => String, nullable: true }) to: string | undefined,
    @CurrentUser() caller: RequestUser,
  ): Promise<CalendarEventType[]> {
    return this.calendarService.events(
      caller.userId,
      workspaceId,
      from,
      to,
    ) as unknown as Promise<CalendarEventType[]>;
  }
}
